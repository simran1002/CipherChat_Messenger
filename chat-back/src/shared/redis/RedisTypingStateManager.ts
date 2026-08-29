import type { Redis } from "ioredis";
import { logger } from "../../utils/logger.js";
import type { ITypingStateManager, TypingExpiryScope } from "../interfaces.js";

/**
 * Typing state as Redis TTL keys: `typing:{chatroomId}:{userId}` → name, PX ttl.
 *
 * Expiry detection uses keyspace notifications (`__keyevent@{db}__:expired`).
 * Every pod subscribes, so every pod hears every expiry and broadcasts
 * stopTyping to its LOCAL sockets only (scope "pod-local") — together the
 * pods cover the whole room exactly once, with no cross-pod adapter hop.
 *
 * What this buys over per-pod timers: if the pod that owned the typist's
 * socket dies mid-type, the key still expires in Redis and the surviving
 * pods clear the indicator for everyone else — no ghost typers across a
 * pod kill.
 *
 * Keyspace notifications are off by default; init() enables them via
 * CONFIG SET (merging with any flags already set). On managed Redis where
 * CONFIG is disabled, the manager falls back to per-pod timers (scope
 * "cluster") — identical behavior to the in-memory implementation, with
 * Redis still holding the authoritative TTL.
 */
export class RedisTypingStateManager implements ITypingStateManager {
  private handler: (chatroomId: string, userId: string, scope: TypingExpiryScope) => void = () => {};
  private subscriber: Redis | null = null;
  private notified = false;
  /** Rooms this pod started typing entries in, per user — for clearUser on disconnect. */
  private readonly owned = new Map<string, Set<string>>();
  private readonly fallbackTimers = new Map<string, NodeJS.Timeout>();
  private readonly ready: Promise<void>;

  constructor(
    private readonly redis: Redis,
    createSubscriber: () => Redis,
    private readonly ttlMs = 4000
  ) {
    this.ready = this.init(createSubscriber);
  }

  onExpire(handler: (chatroomId: string, userId: string, scope: TypingExpiryScope) => void): void {
    this.handler = handler;
  }

  private async init(createSubscriber: () => Redis): Promise<void> {
    try {
      const reply = (await this.redis.config("GET", "notify-keyspace-events")) as [string, string];
      const flags = reply?.[1] ?? "";
      const hasKeyevent = flags.includes("E");
      const hasExpired = flags.includes("x") || flags.includes("A"); // A = all event classes
      if (!hasKeyevent || !hasExpired) {
        await this.redis.config(
          "SET",
          "notify-keyspace-events",
          flags + (hasKeyevent ? "" : "E") + (hasExpired ? "" : "x")
        );
      }

      const db = this.redis.options.db ?? 0;
      const sub = createSubscriber();
      await sub.subscribe(`__keyevent@${db}__:expired`);
      sub.on("message", (_channel, key: string) => {
        if (!key.startsWith("typing:")) return;
        const [, chatroomId, userId] = key.split(":");
        if (!chatroomId || !userId) return;
        this.forget(chatroomId, userId);
        this.handler(chatroomId, userId, "pod-local");
      });
      this.subscriber = sub;
      this.notified = true;
      logger.info("Typing state: Redis TTL keys + keyspace notifications");
    } catch (err) {
      logger.warn(
        "Typing state: keyspace notifications unavailable (CONFIG disabled?) — falling back to per-pod timers",
        { error: err instanceof Error ? err.message : String(err) }
      );
    }
  }

  async start(chatroomId: string, userId: string, name: string): Promise<void> {
    await this.ready;
    await this.redis.set(this.key(chatroomId, userId), name, "PX", this.ttlMs);

    let rooms = this.owned.get(userId);
    if (!rooms) {
      rooms = new Set();
      this.owned.set(userId, rooms);
    }
    rooms.add(chatroomId);

    if (!this.notified) {
      const tk = `${chatroomId}:${userId}`;
      const existing = this.fallbackTimers.get(tk);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.fallbackTimers.delete(tk);
        this.forget(chatroomId, userId);
        void this.redis.del(this.key(chatroomId, userId)).catch(() => {});
        this.handler(chatroomId, userId, "cluster");
      }, this.ttlMs);
      timer.unref();
      this.fallbackTimers.set(tk, timer);
    }
  }

  async stop(chatroomId: string, userId: string): Promise<void> {
    await this.ready;
    this.clearFallbackTimer(chatroomId, userId);
    this.forget(chatroomId, userId);
    // DEL emits a `del` keyevent, not `expired` — no spurious stopTyping.
    await this.redis.del(this.key(chatroomId, userId)).catch(() => {});
  }

  async clearUser(userId: string): Promise<void> {
    await this.ready;
    const rooms = this.owned.get(userId);
    if (!rooms || rooms.size === 0) return;
    const keys = [...rooms].map((room) => this.key(room, userId));
    for (const room of rooms) this.clearFallbackTimer(room, userId);
    this.owned.delete(userId);
    await this.redis.del(...keys).catch(() => {});
  }

  async dispose(): Promise<void> {
    for (const timer of this.fallbackTimers.values()) clearTimeout(timer);
    this.fallbackTimers.clear();
    this.owned.clear();
    if (this.subscriber) {
      await this.subscriber.unsubscribe().catch(() => {});
      await this.subscriber.quit().catch(() => {});
      this.subscriber = null;
    }
  }

  private key(chatroomId: string, userId: string): string {
    return `typing:${chatroomId}:${userId}`;
  }

  private forget(chatroomId: string, userId: string): void {
    const rooms = this.owned.get(userId);
    if (!rooms) return;
    rooms.delete(chatroomId);
    if (rooms.size === 0) this.owned.delete(userId);
  }

  private clearFallbackTimer(chatroomId: string, userId: string): void {
    const tk = `${chatroomId}:${userId}`;
    const timer = this.fallbackTimers.get(tk);
    if (timer) clearTimeout(timer);
    this.fallbackTimers.delete(tk);
  }
}
