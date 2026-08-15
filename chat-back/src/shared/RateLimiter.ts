import type { IRateLimiter } from "./interfaces.js";

/**
 * Token-bucket rate limiter for socket events.
 * Each user's bucket refills at `refillRate` tokens/second, bursting up to
 * `capacity`. A message costs `cost` tokens.
 * Redis swap (Phase 2): atomic Lua token bucket shared across nodes.
 */
export class RateLimiter implements IRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefill: number }>();

  constructor(
    private readonly capacity = 20,
    private readonly refillRate = 2,
    private readonly cost = 1
  ) {}

  async allow(userId: string): Promise<boolean> {
    const now = Date.now();
    let bucket = this.buckets.get(userId);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(userId, bucket);
    }

    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens >= this.cost) {
      bucket.tokens -= this.cost;
      return true;
    }
    return false;
  }

  async clear(userId: string): Promise<void> {
    this.buckets.delete(userId);
  }
}
