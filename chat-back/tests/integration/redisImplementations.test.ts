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

  beforeAll(async () => {
    const { Redis } = await import("ioredis");
    redis = new Redis(REDIS_URL!);
    ({ RedisDeduplicator } = await import("../../src/shared/redis/RedisDeduplicator.js"));
    ({ RedisSequenceCounter } = await import("../../src/shared/redis/RedisSequenceCounter.js"));
    ({ RedisRateLimiter } = await import("../../src/shared/redis/RedisRateLimiter.js"));
    ({ RedisPresenceRegistry } = await import("../../src/shared/redis/RedisPresenceRegistry.js"));
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
});
