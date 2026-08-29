/**
 * Exercises the Redis-backed reliability implementations against a real
 * Redis. Skipped when REDIS_URL is not set (local dev without Redis);
 * CI provides a redis service container so these always run there.
 *
 *   REDIS_URL=redis://localhost:6379 npx vitest run tests/integration/redisImplementations.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)("Redis reliability implementations", () => {
  // Dynamic imports so nothing touches ioredis when the suite is skipped
  let redis: import("ioredis").Redis;
  let RedisDeduplicator: typeof import("../../src/shared/redis/RedisDeduplicator.js").RedisDeduplicator;
  let RedisSequenceCounter: typeof import("../../src/shared/redis/RedisSequenceCounter.js").RedisSequenceCounter;
  let RedisRateLimiter: typeof import("../../src/shared/redis/RedisRateLimiter.js").RedisRateLimiter;
  let RedisPresenceRegistry: typeof import("../../src/shared/redis/RedisPresenceRegistry.js").RedisPresenceRegistry;
  let RedisTypingStateManager: typeof import("../../src/shared/redis/RedisTypingStateManager.js").RedisTypingStateManager;
  let makeRedis: () => import("ioredis").Redis;

  beforeAll(async () => {
    const { Redis } = await import("ioredis");
    makeRedis = () => new Redis(REDIS_URL!);
    redis = makeRedis();
    ({ RedisDeduplicator } = await import("../../src/shared/redis/RedisDeduplicator.js"));
    ({ RedisSequenceCounter } = await import("../../src/shared/redis/RedisSequenceCounter.js"));
    ({ RedisRateLimiter } = await import("../../src/shared/redis/RedisRateLimiter.js"));
    ({ RedisPresenceRegistry } = await import("../../src/shared/redis/RedisPresenceRegistry.js"));
    ({ RedisTypingStateManager } = await import("../../src/shared/redis/RedisTypingStateManager.js"));
  });

  afterAll(async () => {
    await redis?.quit();
  });

  describe("RedisDeduplicator", () => {
    it("returns null for unseen ids, then the marked serverId", async () => {
      const dedup = new RedisDeduplicator(redis, 60);
      const id = randomUUID();
      expect(await dedup.check(id)).toBeNull();
      await dedup.mark(id, "server-1");
      expect(await dedup.check(id)).toBe("server-1");
    });

    it("NX semantics: first mark wins a race", async () => {
      const dedup = new RedisDeduplicator(redis, 60);
      const id = randomUUID();
      await dedup.mark(id, "first");
      await dedup.mark(id, "second");
      expect(await dedup.check(id)).toBe("first");
    });
  });

  describe("RedisSequenceCounter", () => {
    it("seeds from the provided source, then increments atomically", async () => {
      const room = `room-${randomUUID()}`;
      const counter = new RedisSequenceCounter(redis, async () => 100);
      expect(await counter.next(room)).toBe(101);
      expect(await counter.next(room)).toBe(102);
      expect(await counter.current(room)).toBe(102);
    });

    it("issues strictly unique numbers under concurrency", async () => {
      const room = `room-${randomUUID()}`;
      const counter = new RedisSequenceCounter(redis, async () => 0);
      const results = await Promise.all(Array.from({ length: 50 }, () => counter.next(room)));
      expect(new Set(results).size).toBe(50);
      expect(Math.max(...results)).toBe(50);
    });
  });

  describe("RedisRateLimiter (Lua token bucket)", () => {
    it("allows a burst up to capacity, then rejects", async () => {
      const rl = new RedisRateLimiter(redis, 5, 1, 1);
      const user = `u-${randomUUID()}`;
      for (let i = 0; i < 5; i++) expect(await rl.allow(user)).toBe(true);
      expect(await rl.allow(user)).toBe(false);
    });

    it("never over-admits under concurrent fire (atomicity)", async () => {
      const rl = new RedisRateLimiter(redis, 10, 0.0001, 1);
      const user = `u-${randomUUID()}`;
      const results = await Promise.all(Array.from({ length: 30 }, () => rl.allow(user)));
      expect(results.filter(Boolean).length).toBe(10);
    });

    it("clear() refills the bucket", async () => {
      const rl = new RedisRateLimiter(redis, 1, 0.0001, 1);
      const user = `u-${randomUUID()}`;
      expect(await rl.allow(user)).toBe(true);
      expect(await rl.allow(user)).toBe(false);
      await rl.clear(user);
      expect(await rl.allow(user)).toBe(true);
    });
  });

  describe("RedisPresenceRegistry", () => {
    const info = (name: string) => ({
      socketId: "s1",
      name,
      email: `${name}@test.cipher`,
      dp: "",
      presenceStatus: "available",
      presenceNote: "",
    });

    it("set/get/update/delete round-trip", async () => {
      const reg = new RedisPresenceRegistry(redis, 60);
      const id = `user-${randomUUID()}`;
      await reg.set(id, info("Roster Test"));
      expect((await reg.get(id))?.name).toBe("Roster Test");

      expect(await reg.update(id, { presenceStatus: "coding" })).toBe(true);
      expect((await reg.get(id))?.presenceStatus).toBe("coding");

      const listed = await reg.list();
      expect(listed.some((u) => u.userId === id && u.presenceStatus === "coding")).toBe(true);

      await reg.delete(id);
      expect(await reg.get(id)).toBeUndefined();
      expect(await reg.update(id, { name: "x" })).toBe(false);
    });

    it("list() prunes users whose TTL expired", async () => {
      const reg = new RedisPresenceRegistry(redis, 60);
      const id = `user-${randomUUID()}`;
      await reg.set(id, info("Ghost"));
      // Simulate uncleanly-died pod: hash gone, index entry left behind
      await redis.del(`online:${id}`);
      const listed = await reg.list();
      expect(listed.some((u) => u.userId === id)).toBe(false);
      expect(await redis.sismember("online_index", id)).toBe(0);
    });
  });

  describe("RedisTypingStateManager (TTL keys + keyspace notifications)", () => {
    // Redis's active-expiry cycle runs ~10×/s, so the expired event lands
    // shortly AFTER the PX deadline — poll with a generous ceiling.
    const waitFor = async (cond: () => boolean, ms = 5000): Promise<void> => {
      const deadline = Date.now() + ms;
      while (!cond() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const managers: Array<InstanceType<typeof RedisTypingStateManager>> = [];
    const make = (ttlMs: number) => {
      const mgr = new RedisTypingStateManager(redis, makeRedis, ttlMs);
      managers.push(mgr);
      return mgr;
    };

    afterAll(async () => {
      for (const mgr of managers.splice(0)) await mgr.dispose();
    });

    it("fires the expiry handler with pod-local scope after the TTL", async () => {
      const mgr = make(300);
      const calls: Array<[string, string, string]> = [];
      mgr.onExpire((room, user, scope) => calls.push([room, user, scope]));

      const room = `room-${randomUUID()}`;
      await mgr.start(room, "alice", "Alice");
      expect(await redis.exists(`typing:${room}:alice`)).toBe(1);

      await waitFor(() => calls.length > 0);
      expect(calls).toContainEqual([room, "alice", "pod-local"]);
      expect(await redis.exists(`typing:${room}:alice`)).toBe(0);
    });

    it("every pod hears the expiry — a second manager sees a key it never started", async () => {
      const podA = make(300);
      const podB = make(300);
      const heardByB: string[] = [];
      podA.onExpire(() => {});
      podB.onExpire((room) => heardByB.push(room));

      const room = `room-${randomUUID()}`;
      await podA.start(room, "alice", "Alice"); // started on pod A only

      await waitFor(() => heardByB.includes(room));
      expect(heardByB).toContain(room); // pod B can clear the ghost typer
    });

    it("stop() deletes the key without firing the handler", async () => {
      const mgr = make(300);
      const calls: string[] = [];
      mgr.onExpire((room) => calls.push(room));

      const room = `room-${randomUUID()}`;
      await mgr.start(room, "alice", "Alice");
      await mgr.stop(room, "alice");
      expect(await redis.exists(`typing:${room}:alice`)).toBe(0);

      await new Promise((r) => setTimeout(r, 800));
      expect(calls).not.toContain(room);
    });

    it("clearUser() removes every room the user was typing in", async () => {
      const mgr = make(60_000); // long TTL — only clearUser may remove these
      mgr.onExpire(() => {});
      const roomA = `room-${randomUUID()}`;
      const roomB = `room-${randomUUID()}`;
      await mgr.start(roomA, "bob", "Bob");
      await mgr.start(roomB, "bob", "Bob");

      await mgr.clearUser("bob");
      expect(await redis.exists(`typing:${roomA}:bob`)).toBe(0);
      expect(await redis.exists(`typing:${roomB}:bob`)).toBe(0);
    });

    it("repeated start() refreshes the TTL — no premature expiry", async () => {
      const mgr = make(1500);
      const calls: string[] = [];
      mgr.onExpire((room) => calls.push(room));

      const room = `room-${randomUUID()}`;
      await mgr.start(room, "alice", "Alice");
      await new Promise((r) => setTimeout(r, 900));
      await mgr.start(room, "alice", "Alice"); // keystroke — reset TTL
      await new Promise((r) => setTimeout(r, 900)); // 1800ms since first start, 900ms into new TTL
      expect(calls).not.toContain(room);

      await waitFor(() => calls.includes(room));
      expect(calls.filter((r) => r === room)).toHaveLength(1);
    });
  });
});
