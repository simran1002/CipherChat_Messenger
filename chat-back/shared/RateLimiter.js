/**
 * Token-bucket rate limiter for socket events.
 * Each user gets a bucket that refills at REFILL_RATE tokens/second.
 * A message costs COST tokens. Burst up to CAPACITY.
 * Production: implement in Redis with atomic DECRBY + EXPIRE.
 */
const CAPACITY = 20;       // max burst
const REFILL_RATE = 2;     // tokens per second
const COST = 1;            // tokens per message

class RateLimiter {
  constructor() {
    this.buckets = new Map(); // userId → { tokens, lastRefill }
  }

  allow(userId) {
    const now = Date.now();
    let bucket = this.buckets.get(userId);
    if (!bucket) {
      bucket = { tokens: CAPACITY, lastRefill: now };
      this.buckets.set(userId, bucket);
    }

    // Refill
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(CAPACITY, bucket.tokens + elapsed * REFILL_RATE);
    bucket.lastRefill = now;

    if (bucket.tokens >= COST) {
      bucket.tokens -= COST;
      return true;
    }
    return false;
  }

  clear(userId) {
    this.buckets.delete(userId);
  }
}

module.exports = new RateLimiter();
