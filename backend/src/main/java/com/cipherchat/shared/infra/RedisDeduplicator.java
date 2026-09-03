package com.cipherchat.shared.infra;

import java.time.Duration;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

/**
 * Idempotency for client sends. The client attaches a UUID to every message;
 * a retry (ACK lost, reconnect, offline-queue drain) presents the same UUID
 * and gets the ORIGINAL persisted id back instead of a second row.
 *
 * <p>Two layers: {@code SET dedup:<uuid> <messageId> NX EX 600} answers the
 * common case in one round-trip across every replica; the partial unique
 * index on {@code messages.client_message_id} catches the race where two
 * replicas pass the Redis check within the same instant. Fails CLOSED.
 */
@Component
public class RedisDeduplicator {

    private static final Duration TTL = Duration.ofMinutes(10);

    private final StringRedisTemplate redis;

    public RedisDeduplicator(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /** The already-persisted message id for this client id, if we have seen it. */
    public Optional<Long> lookup(UUID clientMessageId) {
        String v = redis.opsForValue().get(key(clientMessageId));
        return v == null || v.isEmpty() ? Optional.empty() : Optional.of(Long.parseLong(v));
    }

    /** Record the mapping; returns false if another replica recorded it first (first writer wins). */
    public boolean mark(UUID clientMessageId, long messageId) {
        return Boolean.TRUE.equals(redis.opsForValue().setIfAbsent(key(clientMessageId), String.valueOf(messageId), TTL));
    }

    private static String key(UUID clientMessageId) {
        return "dedup:" + clientMessageId;
    }
}
