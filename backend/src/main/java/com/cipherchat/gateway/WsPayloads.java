package com.cipherchat.gateway;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import com.cipherchat.chatroom.ChatroomDtos.MessageView;
import com.cipherchat.chatroom.ChatroomDtos.ReplyRef;

/** Frame payloads exchanged over STOMP. Mirrors {@code chat-front/src/types/socket.ts}. */
public final class WsPayloads {

    private WsPayloads() {
    }

    // client → server (/app/…)

    public record RoomSend(@NotNull UUID chatroomId, @NotBlank @Size(max = 2000) String message, UUID clientMessageId,
                           ReplyRef replyTo, Integer expiresIn, @Size(max = 10) List<UUID> mentions) {
    }

    public record RoomRef(@NotNull UUID chatroomId) {
    }

    public record MarkRead(@NotNull UUID chatroomId, Long upToSequence) {
    }

    public record Delivered(@NotNull UUID chatroomId, @NotNull Long messageId) {
    }

    public record OfflineQueue(@NotNull @Size(max = 100) List<RoomSend> messages) {
    }

    /** DM send: exactly one of {@code message} (legacy) or {@code envelope} (E2EE) — enforced by the dm module. */
    public record DmSend(@NotNull UUID conversationId, UUID clientMessageId, @Size(max = 2000) String message,
                         Map<String, Object> envelope) {
    }

    public record DmRef(@NotNull UUID conversationId) {
    }

    // server → client (/topic/…, /user/queue/…)

    public record Ack(boolean ok, String messageId, Long sequenceNumber, boolean duplicate, String error, String clientMessageId) {
        static Ack ok(String messageId, long seq, boolean duplicate, UUID clientId) {
            return new Ack(true, messageId, seq, duplicate, null, clientId == null ? null : clientId.toString());
        }

        static Ack fail(String error, UUID clientId) {
            return new Ack(false, null, null, false, error, clientId == null ? null : clientId.toString());
        }
    }

    public record NewMessage(String event, MessageView message) {
    }

    public record RoomEvent(String event, String chatroomId, Object payload) {
    }

    public record UserEvent(String event, Object payload) {
    }

    public record SyncResult(List<Ack> results) {
    }
}
