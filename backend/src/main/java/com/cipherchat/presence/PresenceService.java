package com.cipherchat.presence;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import com.cipherchat.shared.events.MessagingEvents.UserOffline;
import com.cipherchat.shared.events.MessagingEvents.UserOnline;
import com.cipherchat.user.PresenceStatus;
import com.cipherchat.user.UserService;
import com.cipherchat.user.UserView;

/**
 * Presence lifecycle. Session bookkeeping is delegated to Redis so the roster
 * is identical on every replica; DB writes (is_online / last_seen) are
 * best-effort bookkeeping off the hot path.
 *
 * <p>Typing indicators are Redis keys with a 4-second TTL. Each instance
 * sweeps the keys <em>it</em> started once a second and raises
 * {@link TypingExpired} when one is gone — no ghost typers, and if the owning
 * pod dies its keys simply expire.
 */
@Service
public class PresenceService {

    private static final Logger log = LoggerFactory.getLogger(PresenceService.class);
    private static final Duration TYPING_TTL = Duration.ofSeconds(4);

    /** Raised in-process when a typing indicator times out; the gateway fans it out. */
    public record TypingExpired(UUID chatroomId, UUID userId) {
    }

    public record RosterEntry(String userId, String name, String dp, String presenceStatus, String presenceNote) {
    }

    /** Bounded: the first {@code rosterCap} entries plus the real total. */
    public record Roster(int total, List<RosterEntry> users) {
    }

    private final PresenceRegistry registry;
    private final UserService users;
    private final StringRedisTemplate redis;
    private final ApplicationEventPublisher events;
    private final String pod;
    private final int rosterCap;
    /** typing keys this instance started: "room:user" → expiry deadline (local index for the sweep). */
    private final Map<String, Instant> typingOwned = new ConcurrentHashMap<>();

    public PresenceService(PresenceRegistry registry, UserService users, StringRedisTemplate redis,
                           ApplicationEventPublisher events,
                           @Value("${HOSTNAME:local}") String pod,
                           @Value("${cipherchat.presence.roster-cap}") int rosterCap) {
        this.registry = registry;
        this.users = users;
        this.redis = redis;
        this.events = events;
        this.pod = pod;
        this.rosterCap = rosterCap;
    }

    /** A socket connected. Returns true when the user just came online (first session anywhere). */
    public boolean connected(UUID userId) {
        Optional<UserView> user = users.find(userId);
        if (user.isEmpty()) return false;
        UserView u = user.get();
        boolean cameOnline = registry.connect(new PresenceRegistry.Entry(
                userId, u.name(), u.dp(), u.presenceStatus().value(), u.presenceNote()));
        if (cameOnline) {
            users.setOnline(userId, true);
            events.publishEvent(new UserOnline(UUID.randomUUID(), Instant.now(), userId, pod));
            log.info("User online userId={} pod={}", userId, pod);
        }
        return cameOnline;
    }

    /** A socket disconnected. Returns true when the user's last session is gone. */
    public boolean disconnected(UUID userId) {
        boolean wentOffline = registry.disconnect(userId);
        if (wentOffline) {
            users.setOnline(userId, false);
            events.publishEvent(new UserOffline(UUID.randomUUID(), Instant.now(), userId, pod));
            log.info("User offline userId={} pod={}", userId, pod);
        }
        return wentOffline;
    }

    /** Heartbeat: refresh the TTL; self-heal if the entry expired while the socket stayed up. */
    public boolean heartbeat(UUID userId) {
        if (registry.isOnline(userId)) {
            registry.touch(userId);
            return false;
        }
        return connected(userId);
    }

    public void updateStatus(UUID userId, PresenceStatus status, String note) {
        UserView updated = users.setPresence(userId, status, note);
        registry.update(userId, updated.presenceStatus().value(), updated.presenceNote());
    }

    public Roster roster() {
        List<PresenceRegistry.Entry> all = registry.list();
        List<RosterEntry> shown = all.stream().limit(rosterCap)
                .map(e -> new RosterEntry(e.userId().toString(), e.name(), e.dp(), e.status(), e.note()))
                .toList();
        return new Roster(all.size(), shown);
    }

    // ── typing ───────────────────────────────────────────────────────────────

    public void typingStarted(UUID chatroomId, UUID userId) {
        String key = typingKey(chatroomId, userId);
        redis.opsForValue().set(key, "1", TYPING_TTL);
        typingOwned.put(chatroomId + ":" + userId, Instant.now().plus(TYPING_TTL));
    }

    public void typingStopped(UUID chatroomId, UUID userId) {
        redis.delete(typingKey(chatroomId, userId));
        typingOwned.remove(chatroomId + ":" + userId);
    }

    public void clearTyping(UUID userId) {
        typingOwned.keySet().removeIf(k -> {
            if (k.endsWith(":" + userId)) {
                redis.delete("typing:" + k);
                return true;
            }
            return false;
        });
    }

    @Scheduled(fixedDelay = 1000)
    public void sweepTyping() {
        Instant now = Instant.now();
        typingOwned.forEach((k, deadline) -> {
            if (now.isAfter(deadline) || !Boolean.TRUE.equals(redis.hasKey("typing:" + k))) {
                typingOwned.remove(k);
                int i = k.indexOf(':');
                events.publishEvent(new TypingExpired(UUID.fromString(k.substring(0, i)), UUID.fromString(k.substring(i + 1))));
            }
        });
    }

    private static String typingKey(UUID chatroomId, UUID userId) {
        return "typing:" + chatroomId + ":" + userId;
    }
}
