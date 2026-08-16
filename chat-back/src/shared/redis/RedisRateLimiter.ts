import type { Redis } from "ioredis";
import type { IRateLimiter } from "../interfaces.js";

/**
 * Token bucket in Redis, evaluated atomically as a Lua script so concurrent
 * requests across replicas can never double-spend tokens. State per user:
 * HSET rate:{userId} tokens <float> ts <ms>, expiring after an idle period.
 */
const TOKEN_BUCKET_LUA = `
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill   = tonumber(ARGV[2])
local cost     = tonumber(ARGV[3])
local now      = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- expire after the bucket would be full again anyway (idle cleanup)
redis.call('PEXPIRE', key, math.ceil(capacity / refill * 1000) + 60000)

return allowed
`;

export class RedisRateLimiter implements IRateLimiter {
  private sha: string | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly capacity = 20,
    private readonly refillRate = 2,
    private readonly cost = 1
  ) {}

  async allow(userId: string): Promise<boolean> {
    const args = [
      `rate:${userId}`,
      String(this.capacity),
      String(this.refillRate),
      String(this.cost),
      String(Date.now()),
    ];
    try {
      if (!this.sha) {
        this.sha = (await this.redis.script("LOAD", TOKEN_BUCKET_LUA)) as string;
      }
      const result = await this.redis.evalsha(this.sha, 1, ...args);
      return result === 1;
    } catch (err) {
      // NOSCRIPT after a Redis restart — reload once
      if (err instanceof Error && err.message.includes("NOSCRIPT")) {
        this.sha = (await this.redis.script("LOAD", TOKEN_BUCKET_LUA)) as string;
        const result = await this.redis.evalsha(this.sha, 1, ...args);
        return result === 1;
      }
      throw err;
    }
  }

  async clear(userId: string): Promise<void> {
    await this.redis.del(`rate:${userId}`);
  }
}
