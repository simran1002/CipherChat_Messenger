package com.cipherchat.gateway;

import java.util.Map;
import java.util.UUID;

import org.springframework.modulith.events.ApplicationModuleListener;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;

import com.cipherchat.chatroom.ChatroomDtos.MessageView;
import com.cipherchat.chatroom.MessageService;
import com.cipherchat.dm.DmDtos;
import com.cipherchat.dm.DmService;
import com.cipherchat.shared.events.MessagingEvents.DirectMessageSent;
import com.cipherchat.shared.events.MessagingEvents.MessageDeleted;
import com.cipherchat.shared.events.MessagingEvents.MessageDelivered;
import com.cipherchat.shared.events.MessagingEvents.MessageEdited;
import com.cipherchat.shared.events.MessagingEvents.MessagePinned;
import com.cipherchat.shared.events.MessagingEvents.MessageRead;
import com.cipherchat.shared.events.MessagingEvents.MessageSent;
import com.cipherchat.shared.events.MessagingEvents.ReactionUpdated;
import com.cipherchat.shared.infra.AsyncConfig;

/**
 * Domain events → live sessions. Listeners run asynchronously after the
 * producing transaction commits (Modulith's {@link ApplicationModuleListener}),
 * so a client can never see a message the database has not durably stored.
 *
 * <p>They run with {@code propagation = NOT_SUPPORTED}: a broadcast is a Redis publish plus at
 * most one read, and the annotation's default {@code REQUIRES_NEW} pinned a pooled JDBC
 * connection for every broadcast. Under a burst that exhausted the pool and put the live
 * fan-out behind the database queue (measured: broadcast p95 of 6–10 s at 40 msg/s).
 *
 * <p>They also run on their own executor ({@link AsyncConfig#FANOUT_EXECUTOR}): the default
 * event executor is shared with Kafka externalization, and a broker stall (measured up to 10 s in
 * the Compose VM) filled it with blocked externalizations while broadcasts queued behind them.
 */
@Component
public class DomainEventFanout {

    private final MessageService messages;
    private final DmService dms;
    private final RedisFanout fanout;

    public DomainEventFanout(MessageService messages, DmService dms, RedisFanout fanout) {
        this.messages = messages;
        this.dms = dms;
        this.fanout = fanout;
    }

    /**
     * DM fan-out is content-free on the notification path: the recipient's
     * toast only learns "who" and "encrypted or not"; the envelope itself
     * travels on the conversation topic, where only the two participants
     * are subscribed (authorised at SUBSCRIBE time).
     */
    @Async(AsyncConfig.FANOUT_EXECUTOR)
    @ApplicationModuleListener(propagation = Propagation.NOT_SUPPORTED)
    public void on(DirectMessageSent e) {
        DmDtos.MessageView view = dms.view(e.messageId());
        fanout.toConversation(e.conversationId(), "newDirectMessage", view);
        fanout.toUser(e.recipientId(), "dmNotification", Map.of(
                "conversationId", e.conversationId().toString(),
                "messageId", String.valueOf(e.messageId()),
                "from", e.senderName(),
                "fromId", e.senderId().toString(),
                "encrypted", e.encrypted(),
                "message", e.encrypted() ? "🔒 Encrypted message" : (view.message() == null ? "" : view.message())));
    }

    @Async(AsyncConfig.FANOUT_EXECUTOR)
    @ApplicationModuleListener(propagation = Propagation.NOT_SUPPORTED)
    public void on(MessageSent e) {
        MessageView view = messages.view(e.messageId());
        fanout.toRoom(e.chatroomId(), "newMessage", view);
        // Real-time toast for @mentions; the durable notification row is written by the Kafka consumer.
        for (UUID mentioned : e.mentions()) {
            if (!mentioned.equals(e.senderId())) {
                fanout.toUser(mentioned, "mentionNotification", Map.of(
                        "chatroomId", e.chatroomId().toString(),
                        "messageId", String.valueOf(e.messageId()),
                        "from", e.senderName(),
                        "preview", e.preview()));
            }
        }
    }

    // Room-local UI events (edit/delete/pin/react) — the REST write already committed; tell the live sessions.

    @Async(AsyncConfig.FANOUT_EXECUTOR)
    @ApplicationModuleListener(propagation = Propagation.NOT_SUPPORTED)
    public void on(MessageEdited e) {
        fanout.toRoom(e.chatroomId(), "messageEdited", Map.of(
                "messageId", String.valueOf(e.messageId()), "newText", e.newText()));
    }

    @Async(AsyncConfig.FANOUT_EXECUTOR)
    @ApplicationModuleListener(propagation = Propagation.NOT_SUPPORTED)
    public void on(MessageDeleted e) {
        fanout.toRoom(e.chatroomId(), "messageDeleted", Map.of("messageId", String.valueOf(e.messageId())));
    }

    @Async(AsyncConfig.FANOUT_EXECUTOR)
    @ApplicationModuleListener(propagation = Propagation.NOT_SUPPORTED)
    public void on(MessagePinned e) {
        fanout.toRoom(e.chatroomId(), "messagePinned", Map.of(
                "messageId", String.valueOf(e.messageId()), "pinned", e.pinned()));
    }

    @Async(AsyncConfig.FANOUT_EXECUTOR)
    @ApplicationModuleListener(propagation = Propagation.NOT_SUPPORTED)
    public void on(ReactionUpdated e) {
        fanout.toRoom(e.chatroomId(), "reactionUpdated", Map.of(
                "messageId", String.valueOf(e.messageId()), "reactions", messages.reactionsOf(e.messageId())));
    }

    @Async(AsyncConfig.FANOUT_EXECUTOR)
    @ApplicationModuleListener(propagation = Propagation.NOT_SUPPORTED)
    public void on(MessageRead e) {
        fanout.toRoom(e.chatroomId(), "messagesRead", Map.of(
                "userId", e.userId().toString(),
                "chatroomId", e.chatroomId().toString(),
                "upToSequence", e.upToSequence(),
                "readAt", e.occurredAt().toString()));
    }

    @Async(AsyncConfig.FANOUT_EXECUTOR)
    @ApplicationModuleListener(propagation = Propagation.NOT_SUPPORTED)
    public void on(MessageDelivered e) {
        // Clients render the full recipient list, not a delta — one lookup, then everyone agrees.
        fanout.toRoom(e.chatroomId(), "messageDeliveryUpdate", Map.of(
                "messageId", String.valueOf(e.messageId()),
                "userId", e.userId().toString(),
                "deliveredTo", messages.view(e.messageId()).deliveredTo()));
    }
}
