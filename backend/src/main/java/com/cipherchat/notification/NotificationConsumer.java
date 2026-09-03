package com.cipherchat.notification;

import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaHandler;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import com.cipherchat.shared.events.MessagingEvents.DirectMessageSent;
import com.cipherchat.shared.events.MessagingEvents.MessageSent;
import com.cipherchat.shared.events.MessagingEvents.NotificationRequested;
import com.cipherchat.shared.kafka.ProcessedEventLedger;

/**
 * Consumer group {@code notifications}. Each handler is one database
 * transaction: ledger claim + row insert commit together, and the offset is
 * committed after the method returns. Crash anywhere → redelivery → claim
 * loses → no-op.
 *
 * <p>The transaction is opened explicitly with {@link TransactionTemplate}
 * rather than {@code @Transactional}: a class-level {@code @KafkaListener}
 * can be bound to the bean before the transaction proxy wraps it, in which
 * case the annotation silently never applies and the {@code MANDATORY}
 * ledger claim fails on every record.
 */
@Component
@KafkaListener(id = "notifications", groupId = "notifications",
        topics = {"${cipherchat.kafka.topics.message-events}", "${cipherchat.kafka.topics.notification-events}"},
        concurrency = "${cipherchat.kafka.consumer-concurrency:3}")
public class NotificationConsumer {

    private static final Logger log = LoggerFactory.getLogger(NotificationConsumer.class);
    static final String CONSUMER = "notifications";

    private final NotificationRepository notifications;
    private final ProcessedEventLedger ledger;
    private final TransactionTemplate tx;

    public NotificationConsumer(NotificationRepository notifications, ProcessedEventLedger ledger, TransactionTemplate tx) {
        this.notifications = notifications;
        this.ledger = ledger;
        this.tx = tx;
    }

    /** @mentions become durable "mention" notifications for everyone mentioned except the author. */
    @KafkaHandler
    public void on(MessageSent e) {
        if (e.mentions().isEmpty()) return;
        tx.executeWithoutResult(status -> {
            if (!ledger.claim(CONSUMER, e.eventId())) return;
            for (UUID mentioned : e.mentions()) {
                if (mentioned.equals(e.senderId())) continue;
                notifications.save(Notification.of(mentioned, "mention", Map.of(
                        "chatroomId", e.chatroomId().toString(),
                        "messageId", String.valueOf(e.messageId()),
                        "fromId", e.senderId().toString(),
                        "from", e.senderName(),
                        "preview", e.preview())));
            }
        });
    }

    /** DMs: content-free — the inbox knows who wrote, never what. */
    @KafkaHandler
    public void on(DirectMessageSent e) {
        tx.executeWithoutResult(status -> {
            if (!ledger.claim(CONSUMER, e.eventId())) return;
            notifications.save(Notification.of(e.recipientId(), "dm", Map.of(
                    "conversationId", e.conversationId().toString(),
                    "messageId", String.valueOf(e.messageId()),
                    "fromId", e.senderId().toString(),
                    "from", e.senderName(),
                    "encrypted", e.encrypted())));
        });
    }

    @KafkaHandler
    public void on(NotificationRequested e) {
        tx.executeWithoutResult(status -> {
            if (!ledger.claim(CONSUMER, e.eventId())) return;
            notifications.save(Notification.of(e.userId(), e.type(), Map.of(
                    "title", e.title() == null ? "" : e.title(),
                    "body", e.body() == null ? "" : e.body(),
                    "link", e.link() == null ? "" : e.link())));
        });
    }

    /** Other events on the shared topic (receipts, …) are not this consumer's business. */
    @KafkaHandler(isDefault = true)
    public void ignore(Object other) {
        log.trace("Ignoring {}", other.getClass().getSimpleName());
    }
}
