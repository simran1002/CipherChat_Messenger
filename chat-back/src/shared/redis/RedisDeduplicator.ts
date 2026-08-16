import type { Redis } from "ioredis";
import type { IDeduplicator } from "../interfaces.js";

/**
 * Redis-backed idempotency store, shared by every backend replica.
 * mark(): SET dedup:{clientId} {serverId} EX ttl NX — atomic, so two replicas
 * racing the same retry can never both persist.
 */
export class RedisDeduplicator implements IDeduplicator {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = 600
  ) {}

  async check(clientMessageId: string): Promise<string | null> {
    return this.redis.get(`dedup:${clientMessageId}`);
  }

  async mark(clientMessageId: string, serverId: string): Promise<void> {
    await this.redis.set(`dedup:${clientMessageId}`, serverId, "EX", this.ttlSeconds, "NX");
  }

  stop(): void {
    // connection lifecycle is owned by config/redis.ts
  }
}
