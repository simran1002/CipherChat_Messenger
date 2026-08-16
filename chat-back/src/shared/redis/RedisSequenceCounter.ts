import type { Redis } from "ioredis";
import type { ISequenceCounter } from "../interfaces.js";

/**
 * Per-room monotonic sequence via Redis INCR — atomic across replicas.
 * On first use of a room, the counter is seeded from the database's
 * max(sequenceNumber) with SETNX, so neither restarts nor blue/green deploys
 * ever re-issue a number (the in-memory version had exactly that bug).
 */
export class RedisSequenceCounter implements ISequenceCounter {
  constructor(
    private readonly redis: Redis,
    private readonly seed: (chatroomId: string) => Promise<number>
  ) {}

  private key(chatroomId: string): string {
    return `seq:${chatroomId}`;
  }

  async next(chatroomId: string): Promise<number> {
    await this.ensureSeeded(chatroomId);
    return this.redis.incr(this.key(chatroomId));
  }

  async current(chatroomId: string): Promise<number> {
    await this.ensureSeeded(chatroomId);
    const val = await this.redis.get(this.key(chatroomId));
    return val ? parseInt(val, 10) : 0;
  }

  private async ensureSeeded(chatroomId: string): Promise<void> {
    const exists = await this.redis.exists(this.key(chatroomId));
    if (!exists) {
      const max = await this.seed(chatroomId);
      // NX: if another replica seeded in the meantime, keep theirs
      await this.redis.set(this.key(chatroomId), String(max), "NX");
    }
  }
}
