package com.cipherchat.dm;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import com.cipherchat.user.UserView;

public final class DmDtos {

    private DmDtos() {
    }

    public record StartRequest(@NotNull UUID targetUserId) {
    }

    /** Exactly one of {@code message} (legacy plaintext) or {@code envelope} (E2EE) must be present. */
    public record SendRequest(UUID clientMessageId, @Size(max = 2000) String message, Map<String, Object> envelope) {
    }

    public record Preview(String message, boolean encrypted, Instant createdAt) {
    }

    public record ConversationView(String id, UserView.Summary participant, Preview lastMessage, Instant lastMessageAt) {
    }

    public record MessageView(
            String id, DmMessage.Type type, String message, Map<String, Object> envelope, String clientMessageId,
            boolean edited, String userId, UserView.Summary user, Instant createdAt) {
    }

    public record HistoryPage(List<MessageView> messages, UserView.Summary participant, Cursor cursor) {
        public record Cursor(String nextCursor, boolean hasMore, int limit) {
        }
    }

    public record SendResult(boolean ok, String messageId, boolean duplicate, MessageView message) {
    }
}
