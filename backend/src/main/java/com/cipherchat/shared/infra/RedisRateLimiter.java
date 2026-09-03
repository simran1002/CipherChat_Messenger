package com.cipherchat.shared.infra;

import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

/**
 * Token-bucket rate limiter as ONE atomic Lua script — refill and consume in
 * a single Redis round-trip, so N replicas share one budget with no
 * read-modify-write race.
 *
 * <p>Fails OPEN: if Redis is unreachable the request is allowed and the
 * outage is logged. A Redis blip must degrade to "briefly unthrottled", never
 * to "the whole API is down" — availability over strictness for this control.
 * (Persistence-critical Redis uses — dedup and sequences — fail CLOSED instead;
 * see {@link RedisDeduplicator} and {@link RedisSequenceCounter}.)
 */
@Component
public class RedisRateLimiter {

    private static final Logger log = LoggerFactory.getLogger(RedisRateLimiter.class);

    private static final DefaultRedisScript<Long> SCRIPT = new DefaultRedisScript<>("""
            local key = KEYS[1]
            local capacity = tonumber(ARGV[1])
            local refill_per_ms = tonumber(ARGV[2])
            local now = tonumber(ARGV[3])
            local ttl = tonumber(ARGV[4])
            local bucket = redis.call('HMGET', key, 'tokens', 'ts')
            local tokens = tonumber(bucket[1])
            local ts = tonumber(bucket[2])
            if tokens == nil then tokens = capacity; ts = now end
            local elapsed = math.max(0, now - ts)
            tokens = math.min(capacity, tokens + elapsed * refill_per_ms)
            local allowed = 0
            if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
            redis.call('HSET', key, 'tokens', tokens, 'ts', now)
            redis.call('PEXPIRE', key, ttl)
            return allowed
            """, Long.class);

    private final StringRedisTemplate redis;

    public RedisRateLimiter(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /**
     * @param key            bucket identity, e.g. {@code rl:msg:<userId>} or {@code rl:auth:<ip>}
     * @param capacity       burst size
     * @param refillPerSecond sustained rate
     */
    public boolean tryAcquire(String key, int capacity, double refillPerSecond) {
        long ttlMs = (long) Math.ceil(capacity / refillPerSecond * 1000) * 2;
        try {
            Long allowed = redis.execute(SCRIPT, List.of(key),
                    String.valueOf(capacity),
                    String.valueOf(refillPerSecond / 1000.0),
                    String.valueOf(System.currentTimeMillis()),
                    String.valueOf(Math.max(ttlMs, 1000)));
            return allowed != null && allowed == 1L;
        } catch (DataAccessException e) {
            log.warn("Rate limiter unavailable (failing open) key={} cause={}", key, e.getMostSpecificCause().getMessage());
            return true;
        }
    }

    public void reset(String key) {
        try {
            redis.delete(key);
        } catch (DataAccessException ignored) {
            // best-effort
        }
    }
}
