package com.cipherchat.presence;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

/**
 * Online roster in Redis — the source of truth every replica reads.
 *
 * <pre>
 *   online:&lt;userId&gt;   HASH {name, dp, status, note, sessions}   EX ttl
 *   online_index       SET of userIds (pruned lazily on list())
 * </pre>
 *
 * A user with three tabs/devices is one entry with {@code sessions=3}; the
 * entry disappears when the last session leaves. The TTL is the safety net:
 * if a pod dies without sending disconnects, its users' entries expire after
 * missing three heartbeats instead of showing online forever.
 */
@Component
public class PresenceRegistry {

    public record Entry(UUID userId, String name, String dp, String status, String note) {
    }

    private static final String INDEX = "online_index";

    private final StringRedisTemplate redis;
    private final Duration ttl;

    public PresenceRegistry(StringRedisTemplate redis, @Value("${cipherchat.presence.ttl}") Duration ttl) {
        this.redis = redis;
        this.ttl = ttl;
    }

    /** Register a session; returns true if this made the user online (first session). */
    public boolean connect(Entry e) {
        String key = key(e.userId());
        Long sessions = redis.opsForHash().increment(key, "sessions", 1);
        redis.opsForHash().putAll(key, Map.of("name", e.name(), "dp", e.dp(), "status", e.status(), "note", e.note()));
        redis.expire(key, ttl);
        redis.opsForSet().add(INDEX, e.userId().toString());
        return sessions != null && sessions == 1L;
    }

    /** Unregister a session; returns true if this took the user offline (last session). */
    public boolean disconnect(UUID userId) {
        String key = key(userId);
        Long sessions = redis.opsForHash().increment(key, "sessions", -1);
        if (sessions == null || sessions <= 0) {
            redis.delete(key);
            redis.opsForSet().remove(INDEX, userId.toString());
            return true;
        }
        return false;
    }

    public void touch(UUID userId) {
        redis.expire(key(userId), ttl);
    }

    public boolean isOnline(UUID userId) {
        return Boolean.TRUE.equals(redis.hasKey(key(userId)));
    }

    public void update(UUID userId, String status, String note) {
        String key = key(userId);
        if (isOnline(userId)) {
            redis.opsForHash().putAll(key, Map.of("status", status, "note", note));
        }
    }

    /** Everyone online, pruning index entries whose hash has expired (dead-pod cleanup). */
    public List<Entry> list() {
        Set<String> ids = redis.opsForSet().members(INDEX);
        List<Entry> out = new ArrayList<>();
        if (ids == null) return out;
        for (String id : ids) {
            Map<Object, Object> h = redis.opsForHash().entries(key(UUID.fromString(id)));
            if (h.isEmpty()) {
                redis.opsForSet().remove(INDEX, id);
                continue;
            }
            out.add(new Entry(UUID.fromString(id), str(h, "name"), str(h, "dp"), str(h, "status"), str(h, "note")));
        }
        out.sort((a, b) -> a.name().compareToIgnoreCase(b.name()));
        return out;
    }

    private static String str(Map<Object, Object> h, String k) {
        Object v = h.get(k);
        return v == null ? "" : v.toString();
    }

    private static String key(UUID userId) {
        return "online:" + userId;
    }
}
