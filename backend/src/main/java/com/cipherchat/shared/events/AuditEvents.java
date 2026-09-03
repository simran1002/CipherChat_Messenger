package com.cipherchat.shared.events;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.springframework.modulith.events.Externalized;

/**
 * Security-relevant actions, recorded by the audit module. Published — not
 * written directly — so the auth/chatroom modules never depend on audit, and
 * a slow audit store can never delay a login.
 */
public final class AuditEvents {

    private AuditEvents() {
    }

    public static final String AUDIT_EVENTS = "audit-events";

    @Externalized(AUDIT_EVENTS + "::#{#this.partitionKey()}")
    public record Audited(
            UUID eventId,
            Instant occurredAt,
            UUID actorId,            // null for anonymous actions (e.g. failed login for unknown email)
            String action,           // user.login, user.login_failed, user.logout, user.password_changed, …
            String targetType,
            String targetId,
            Map<String, Object> metadata,
            String ip) {

        public static Audited of(UUID actorId, String action, String targetType, String targetId,
                                 Map<String, Object> metadata, String ip) {
            return new Audited(UUID.randomUUID(), Instant.now(), actorId, action, targetType, targetId,
                    metadata == null ? Map.of() : metadata, ip == null ? "" : ip);
        }

        public String partitionKey() {
            return actorId == null ? "anonymous" : actorId.toString();
        }
    }
}
