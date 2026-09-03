package com.cipherchat.shared.events;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.springframework.modulith.events.Externalized;

/**
 * Domain events that cross module boundaries. Each carries its own
 * {@code eventId} so consumers can be idempotent (Kafka is at-least-once) and
 * an {@code occurredAt} timestamp assigned by the producer.
 *
 * <p>{@link Externalized} publishes the event to Kafka <em>after</em> the
 * producing transaction commits, via the persisted event-publication registry
 * (transactional outbox). The routing key is the room/conversation id so every
 * event for one conversation lands on the same partition and is consumed in
 * order.
 *
 * <p>Why events + Kafka rather than synchronous calls: the send path must
 * finish with "persisted + ACKed" and nothing else. Notification fan-out,
 * analytics, audit and search indexing are consumers that may be slow, down
 * or replaying — none of them should add latency to, or be able to fail, a
 * user's message.
 */
public final class MessagingEvents {

    private MessagingEvents() {
    }

    public static final String MESSAGE_EVENTS = "message-events";
    public static final String PRESENCE_EVENTS = "presence-events";
    public static final String NOTIFICATION_EVENTS = "notification-events";

    /** A room message was persisted (exactly once — the sequence slot is unique). */
    @Externalized(MESSAGE_EVENTS + "::#{#this.chatroomId()}")
    public record MessageSent(
            UUID eventId,
            Instant occurredAt,
            UUID chatroomId,
            long messageId,
            long sequenceNumber,
            UUID senderId,
            String senderName,
            String preview,
            List<UUID> mentions) {
    }

    /** A direct message (E2EE envelope or legacy plaintext) was persisted. */
    @Externalized(MESSAGE_EVENTS + "::#{#this.conversationId()}")
    public record DirectMessageSent(
            UUID eventId,
            Instant occurredAt,
            UUID conversationId,
            long messageId,
            UUID senderId,
            String senderName,
            UUID recipientId,
            boolean encrypted) {
    }

    @Externalized(MESSAGE_EVENTS + "::#{#this.chatroomId()}")
    public record MessageDelivered(UUID eventId, Instant occurredAt, UUID chatroomId, long messageId, UUID userId) {
    }

    @Externalized(MESSAGE_EVENTS + "::#{#this.chatroomId()}")
    public record MessageRead(UUID eventId, Instant occurredAt, UUID chatroomId, UUID userId, long upToSequence) {
    }

    @Externalized(PRESENCE_EVENTS + "::#{#this.userId()}")
    public record UserOnline(UUID eventId, Instant occurredAt, UUID userId, String pod) {
    }

    @Externalized(PRESENCE_EVENTS + "::#{#this.userId()}")
    public record UserOffline(UUID eventId, Instant occurredAt, UUID userId, String pod) {
    }

    /** A consumer decided someone should be told something (mention, DM, invite). */
    @Externalized(NOTIFICATION_EVENTS + "::#{#this.userId()}")
    public record NotificationRequested(
            UUID eventId, Instant occurredAt, UUID userId, String type, String title, String body, String link) {
    }

    // ── Room-local UI events: NOT externalized. They exist to reach live sessions on every
    //    replica (via the gateway's Redis fan-out); no downstream consumer needs them durably.

    public record MessageEdited(UUID eventId, Instant occurredAt, UUID chatroomId, long messageId, String newText) {
    }

    public record MessageDeleted(UUID eventId, Instant occurredAt, UUID chatroomId, long messageId) {
    }

    public record MessagePinned(UUID eventId, Instant occurredAt, UUID chatroomId, long messageId, boolean pinned) {
    }

    public record ReactionUpdated(UUID eventId, Instant occurredAt, UUID chatroomId, long messageId) {
    }
}
