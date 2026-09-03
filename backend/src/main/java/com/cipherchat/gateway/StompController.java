package com.cipherchat.gateway;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.validation.Valid;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Controller;
import org.springframework.validation.annotation.Validated;

import com.cipherchat.chatroom.ChatroomDtos.SendMessageRequest;
import com.cipherchat.chatroom.ChatroomDtos.SendResult;
import com.cipherchat.chatroom.MessageService;
import com.cipherchat.dm.DmDtos;
import com.cipherchat.dm.DmService;
import com.cipherchat.gateway.StompAuthInterceptor.StompPrincipal;
import com.cipherchat.gateway.WsPayloads.Ack;
import com.cipherchat.gateway.WsPayloads.Delivered;
import com.cipherchat.gateway.WsPayloads.DmRef;
import com.cipherchat.gateway.WsPayloads.DmSend;
import com.cipherchat.gateway.WsPayloads.MarkRead;
import com.cipherchat.gateway.WsPayloads.OfflineQueue;
import com.cipherchat.gateway.WsPayloads.RoomSend;
import com.cipherchat.gateway.WsPayloads.SyncResult;
import com.cipherchat.shared.api.ApiException;

/**
 * Client → server STOMP frames. Handlers are thin: validate, delegate to the
 * domain module, reply to the sender's private queue. Broadcasts to rooms are
 * NOT done here — they happen in {@link RedisFanout} in reaction to domain
 * events, so a message reaches every replica's subscribers, not just this
 * JVM's.
 */
@Controller
@Validated
public class StompController {

    private static final Logger log = LoggerFactory.getLogger(StompController.class);
    static final String ACK_QUEUE = "/queue/acks";

    private final MessageService messages;
    private final DmService dms;
    private final RedisFanout fanout;
    private final SimpMessagingTemplate template;

    public StompController(MessageService messages, DmService dms, RedisFanout fanout, SimpMessagingTemplate template) {
        this.messages = messages;
        this.dms = dms;
        this.fanout = fanout;
        this.template = template;
    }

    /** Send a room message; the ACK (with server id + sequence, or an error code) goes to /user/queue/acks. */
    @MessageMapping("/rooms/send")
    public void send(@Valid @Payload RoomSend frame, StompPrincipal principal) {
        template.convertAndSendToUser(principal.getName(), ACK_QUEUE, attempt(principal.user().id(), frame));
    }

    /** Offline-queue drain: each item is idempotent on its client id, so replaying is safe. */
    @MessageMapping("/rooms/sync")
    public void sync(@Valid @Payload OfflineQueue frame, StompPrincipal principal) {
        List<Ack> results = new ArrayList<>(frame.messages().size());
        for (RoomSend item : frame.messages()) {
            results.add(attempt(principal.user().id(), item));
        }
        template.convertAndSendToUser(principal.getName(), "/queue/sync", new SyncResult(results));
    }

    @MessageMapping("/rooms/read")
    public void markRead(@Valid @Payload MarkRead frame, StompPrincipal principal) {
        messages.markRead(frame.chatroomId(), principal.user().id(), frame.upToSequence());
    }

    @MessageMapping("/rooms/delivered")
    public void delivered(@Valid @Payload Delivered frame, StompPrincipal principal) {
        messages.markDelivered(frame.messageId(), principal.user().id());
    }

    // ── direct messages ──────────────────────────────────────────────────────

    /** Send a DM (E2EE envelope or legacy plaintext); ACK to /user/queue/acks. No sequence — DMs are id-ordered. */
    @MessageMapping("/dm/send")
    public void sendDm(@Valid @Payload DmSend frame, StompPrincipal principal) {
        UUID userId = principal.user().id();
        Ack ack;
        try {
            DmDtos.SendResult r = dms.send(userId, frame.conversationId(),
                    new DmDtos.SendRequest(frame.clientMessageId(), frame.message(), frame.envelope()));
            ack = new Ack(true, r.messageId(), null, r.duplicate(), null,
                    frame.clientMessageId() == null ? null : frame.clientMessageId().toString());
        } catch (ApiException e) {
            ack = Ack.fail(e.code(), frame.clientMessageId());
        } catch (RuntimeException e) {
            log.error("DM send failed userId={} conversationId={}", userId, frame.conversationId(), e);
            ack = Ack.fail("server_error", frame.clientMessageId());
        }
        template.convertAndSendToUser(principal.getName(), ACK_QUEUE, ack);
    }

    /** Typing relays are ephemeral: no persistence, no TTL — the peer's UI times them out. Participation is still checked. */
    @MessageMapping("/dm/typing")
    public void dmTyping(@Valid @Payload DmRef frame, StompPrincipal principal) {
        relayTyping(frame.conversationId(), principal, "dmUserTyping");
    }

    @MessageMapping("/dm/stopTyping")
    public void dmStopTyping(@Valid @Payload DmRef frame, StompPrincipal principal) {
        relayTyping(frame.conversationId(), principal, "dmUserStopTyping");
    }

    private void relayTyping(UUID conversationId, StompPrincipal principal, String event) {
        try {
            dms.requireParticipant(conversationId, principal.user().id());
        } catch (ApiException denied) {
            return; // silently drop — a typing frame from a non-participant is not worth an error round-trip
        }
        fanout.toConversation(conversationId, event, Map.of(
                "conversationId", conversationId.toString(),
                "userId", principal.user().id().toString()));
    }

    private Ack attempt(UUID userId, RoomSend frame) {
        try {
            SendResult r = messages.send(userId, frame.chatroomId(), new SendMessageRequest(
                    frame.message(), frame.clientMessageId(), frame.replyTo(), frame.expiresIn(), frame.mentions()));
            return Ack.ok(r.messageId(), r.sequenceNumber(), r.duplicate(), frame.clientMessageId());
        } catch (ApiException e) {
            return Ack.fail(e.code(), frame.clientMessageId());
        } catch (RuntimeException e) {
            log.error("Send failed userId={} roomId={}", userId, frame.chatroomId(), e);
            return Ack.fail("server_error", frame.clientMessageId());
        }
    }
}
