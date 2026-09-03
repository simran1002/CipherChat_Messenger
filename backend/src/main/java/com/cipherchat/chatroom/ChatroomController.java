package com.cipherchat.chatroom;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.cipherchat.chatroom.ChatroomDtos.CreateRoomRequest;
import com.cipherchat.chatroom.ChatroomDtos.CursorPage;
import com.cipherchat.chatroom.ChatroomDtos.EditMessageRequest;
import com.cipherchat.chatroom.ChatroomDtos.InviteRequest;
import com.cipherchat.chatroom.ChatroomDtos.MarkReadRequest;
import com.cipherchat.chatroom.ChatroomDtos.MembersView;
import com.cipherchat.chatroom.ChatroomDtos.MessageView;
import com.cipherchat.chatroom.ChatroomDtos.ReactRequest;
import com.cipherchat.chatroom.ChatroomDtos.RoleRequest;
import com.cipherchat.chatroom.ChatroomDtos.RoomView;
import com.cipherchat.chatroom.ChatroomDtos.SearchResult;
import com.cipherchat.chatroom.ChatroomDtos.SendFileMessageRequest;
import com.cipherchat.chatroom.ChatroomDtos.SendMessageRequest;
import com.cipherchat.chatroom.ChatroomDtos.SendResult;
import com.cipherchat.shared.security.CurrentUser;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;

/**
 * REST surface for rooms. Sends are also accepted here (not only over the
 * WebSocket) so the offline-queue drain and any non-socket client get the
 * same exactly-once pipeline and the same ACK shape.
 */
@RestController
@RequestMapping("/api/v1/chatrooms")
@Tag(name = "Chatrooms", description = "Rooms, membership, room messages")
public class ChatroomController {

    private final ChatroomService rooms;
    private final MessageService messages;

    public ChatroomController(ChatroomService rooms, MessageService messages) {
        this.rooms = rooms;
        this.messages = messages;
    }

    // ── rooms ────────────────────────────────────────────────────────────────

    @GetMapping
    @Operation(summary = "Rooms visible to the caller, with role and unread count")
    public List<RoomView> list() {
        return rooms.listFor(CurrentUser.id());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Create a room (caller becomes owner)")
    public RoomView create(@Valid @RequestBody CreateRoomRequest body) {
        return rooms.create(CurrentUser.id(), body.name(), body.isPrivate());
    }

    @GetMapping("/{roomId}/members")
    public MembersView members(@PathVariable UUID roomId) {
        return rooms.members(roomId, CurrentUser.id());
    }

    @PostMapping("/{roomId}/join")
    @Operation(summary = "Self-service join for public rooms")
    public Map<String, String> join(@PathVariable UUID roomId) {
        return Map.of("message", "Joined " + rooms.join(roomId, CurrentUser.id()) + ".", "chatroomId", roomId.toString());
    }

    @PostMapping("/{roomId}/invite")
    @Operation(summary = "Owner/admin adds a member")
    public Map<String, String> invite(@PathVariable UUID roomId, @Valid @RequestBody InviteRequest body) {
        String name = rooms.invite(roomId, CurrentUser.id(), body.userId());
        return Map.of("message", name + " added to the room.", "userId", body.userId().toString());
    }

    @PostMapping("/{roomId}/leave")
    public Map<String, String> leave(@PathVariable UUID roomId) {
        rooms.leave(roomId, CurrentUser.id());
        return Map.of("message", "Left the room.", "chatroomId", roomId.toString());
    }

    @PatchMapping("/{roomId}/members/{userId}")
    @Operation(summary = "Owner changes a member's role; promoting to owner transfers ownership")
    public Map<String, String> role(@PathVariable UUID roomId, @PathVariable UUID userId, @Valid @RequestBody RoleRequest body) {
        rooms.changeRole(roomId, CurrentUser.id(), userId, body.role());
        return Map.of("message", "Role updated.", "userId", userId.toString(), "role", body.role().name());
    }

    // ── messages ─────────────────────────────────────────────────────────────

    @GetMapping("/{roomId}/messages")
    @Operation(summary = "History, cursor-paginated on the room sequence (?before=<seq>&limit=50)")
    public CursorPage history(@PathVariable UUID roomId,
                              @RequestParam(required = false) Long before,
                              @RequestParam(defaultValue = "50") int limit) {
        return messages.history(roomId, CurrentUser.id(), before, limit);
    }

    @PostMapping("/{roomId}/messages")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Send a text message (idempotent on clientMessageId)")
    public SendResult send(@PathVariable UUID roomId, @Valid @RequestBody SendMessageRequest body) {
        return messages.send(CurrentUser.id(), roomId, body);
    }

    @PostMapping("/{roomId}/messages/file")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Send an image / audio / file / location message")
    public SendResult sendFile(@PathVariable UUID roomId, @Valid @RequestBody SendFileMessageRequest body) {
        return messages.sendFile(CurrentUser.id(), roomId, body);
    }

    @GetMapping("/{roomId}/messages/search")
    public SearchResult search(@PathVariable UUID roomId, @RequestParam String q) {
        return new SearchResult(messages.search(roomId, CurrentUser.id(), q), q.trim());
    }

    @GetMapping("/{roomId}/pinned")
    public List<MessageView> pinned(@PathVariable UUID roomId) {
        return messages.pinned(roomId, CurrentUser.id());
    }

    @PostMapping("/{roomId}/read")
    @Operation(summary = "Mark messages read up to a sequence (default: latest); advances the unread watermark")
    public Map<String, Integer> markRead(@PathVariable UUID roomId, @RequestBody(required = false) MarkReadRequest body) {
        return Map.of("marked", messages.markRead(roomId, CurrentUser.id(), body == null ? null : body.upToSequence()));
    }

    @PutMapping("/messages/{messageId}")
    public MessageView edit(@PathVariable long messageId, @Valid @RequestBody EditMessageRequest body) {
        return messages.edit(messageId, CurrentUser.id(), body.message());
    }

    @DeleteMapping("/messages/{messageId}")
    public Map<String, String> delete(@PathVariable long messageId) {
        messages.delete(messageId, CurrentUser.id());
        return Map.of("message", "Message deleted.", "messageId", String.valueOf(messageId));
    }

    @PostMapping("/messages/{messageId}/pin")
    public Map<String, Object> pin(@PathVariable long messageId) {
        boolean pinned = messages.togglePin(messageId, CurrentUser.id());
        return Map.of("pinned", pinned, "messageId", String.valueOf(messageId));
    }

    @PostMapping("/messages/{messageId}/react")
    public Map<String, Object> react(@PathVariable long messageId, @Valid @RequestBody ReactRequest body) {
        return Map.of("reactions", messages.toggleReaction(messageId, CurrentUser.id(), body.emoji()),
                "messageId", String.valueOf(messageId));
    }

    @PostMapping("/messages/{messageId}/delivered")
    public Map<String, Boolean> delivered(@PathVariable long messageId) {
        messages.markDelivered(messageId, CurrentUser.id());
        return Map.of("ok", true);
    }
}
