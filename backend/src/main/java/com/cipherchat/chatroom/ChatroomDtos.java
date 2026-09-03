package com.cipherchat.chatroom;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import com.cipherchat.user.UserView;

/** API shapes for rooms and room messages. Ids are strings on the wire (UUIDs and bigints alike). */
public final class ChatroomDtos {

    private ChatroomDtos() {
    }

    // ── requests ─────────────────────────────────────────────────────────────

    public record CreateRoomRequest(
            @NotBlank @Size(max = 50) @Pattern(regexp = "^[A-Za-z0-9\\s\\-_]+$",
                    message = "Only letters, numbers, spaces, hyphens and underscores") String name,
            boolean isPrivate) {
    }

    /** {@code messageId} is serialised as a string like every other id on the wire (accepts either on input). */
    public record ReplyRef(@NotNull @com.fasterxml.jackson.annotation.JsonFormat(shape = com.fasterxml.jackson.annotation.JsonFormat.Shape.STRING) Long messageId,
                           @Size(max = 200) String preview, @Size(max = 50) String senderName) {
    }

    public record SendMessageRequest(
            @NotBlank @Size(max = 2000) String message,
            UUID clientMessageId,
            ReplyRef replyTo,
            /** seconds until self-destruct; null = never */
            @Min(5) @Max(604800) Integer expiresIn,
            @Size(max = 10) List<UUID> mentions) {
    }

    public record SendFileMessageRequest(
            @NotNull Message.Type type,
            @Size(max = 2000) String message,
            @Size(max = 2048) String fileUrl,
            @Size(max = 255) String fileName,
            @Size(max = 100) String mimeType,
            Long fileSize,
            Double lat,
            Double lng,
            UUID clientMessageId,
            ReplyRef replyTo) {
    }

    public record EditMessageRequest(@NotBlank @Size(max = 2000) String message) {
    }

    public record ReactRequest(@NotBlank @Size(max = 16) String emoji) {
    }

    public record MarkReadRequest(Long upToSequence) {
    }

    public record InviteRequest(@NotNull UUID userId) {
    }

    public record RoleRequest(@NotNull ChatroomMember.Role role) {
    }

    // ── responses ────────────────────────────────────────────────────────────

    public record RoomView(
            String id, String name, boolean isPrivate, String createdBy, String createdByName,
            int memberCount, ChatroomMember.Role myRole, long unreadCount, Instant createdAt) {
    }

    public record RoomSummary(String id, String name, boolean isPrivate) {
    }

    public record MemberView(UserView.Summary user, String email, boolean isOnline, ChatroomMember.Role role, Instant joinedAt) {
    }

    public record MembersView(List<MemberView> members, boolean isPrivate, ChatroomMember.Role myRole) {
    }

    public record ReactionView(String emoji, String user, String name) {
    }

    public record ReceiptView(String user, Instant at) {
    }

    public record MessageView(
            String id,
            String chatroomId,
            Message.Type type,
            String message,
            String userId,
            String name,
            String dp,
            String fileUrl, String fileName, String mimeType, Long fileSize,
            Double lat, Double lng,
            ReplyRef replyTo,
            List<String> mentions,
            List<ReactionView> reactions,
            List<ReceiptView> readBy,
            List<String> deliveredTo,
            boolean pinned,
            boolean edited,
            Instant expiresAt,
            long sequenceNumber,
            String clientMessageId,
            String deliveryStatus,
            Instant createdAt) {
    }

    /** ACK for a send: the persisted identity, plus whether this was a retry we absorbed. */
    public record SendResult(boolean ok, String messageId, long sequenceNumber, boolean duplicate, MessageView message) {
    }

    public record CursorPage(List<MessageView> messages, RoomSummary chatroom, Cursor cursor) {
        public record Cursor(String nextCursor, boolean hasMore, int limit) {
        }
    }

    public record SearchResult(List<MessageView> messages, String query) {
    }
}
