package com.cipherchat.shared.infra;

import java.time.Duration;
import java.util.UUID;
import java.util.function.LongSupplier;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import com.cipherchat.shared.api.ApiException;

/**
 * Per-room monotonic sequence numbers: {@code INCR seq:<room>}.
 *
 * <p>Seeded on first use from the highest persisted sequence for the room
 * ({@code SET NX}, so concurrent seeders can't reset it) — a Redis restart or
 * key eviction therefore resumes from the database, never from zero. The
 * {@code (chatroom_id, sequence_number)} unique constraint is the backstop if
 * both layers are wrong at once: a duplicate slot becomes a rejected insert,
 * not a silently reordered history.
 *
 * <p>Fails CLOSED: without Redis we cannot promise ordering, so the send is
 * rejected (the client's ACK/retry loop will resend once Redis returns).
 */
@Component
public class RedisSequenceCounter {

    private static final Duration KEY_TTL = Duration.ofDays(30);

    private static final Logger log = LoggerFactory.getLogger(RedisSequenceCounter.class);

    private final StringRedisTemplate redis;

    public RedisSequenceCounter(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /**
     * Fails CLOSED: without Redis there is no safe way to hand out a gapless slot, and guessing one
     * would only be caught by the unique index after the fact. The caller gets a 503 with a stable
     * code ({@code redis_unavailable}) so clients retry instead of treating it as a permanent error.
     */
    public long next(UUID roomId, LongSupplier persistedMax) {
        String key = "seq:" + roomId;
        try {
            // Seed only when absent; the value from the DB is the true high-water mark.
            Boolean seeded = redis.opsForValue().setIfAbsent(key, String.valueOf(persistedMax.getAsLong()), KEY_TTL);
            Long next = redis.opsForValue().increment(key);
            if (next == null) {
                throw new IllegalStateException("Sequence counter unavailable for room " + roomId);
            }
            if (Boolean.FALSE.equals(seeded)) {
                redis.expire(key, KEY_TTL);
            }
            return next;
        } catch (DataAccessException e) {
            log.error("Sequence counter unavailable roomId={} cause={}", roomId, e.getMostSpecificCause().getMessage());
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "redis_unavailable",
                    "Message ordering service unavailable — retry shortly.");
        }
    }
}
