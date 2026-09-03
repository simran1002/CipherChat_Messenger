package com.cipherchat.chatroom;

import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.cipherchat.chatroom.ChatroomDtos.MemberView;
import com.cipherchat.chatroom.ChatroomDtos.MembersView;
import com.cipherchat.chatroom.ChatroomDtos.RoomView;
import com.cipherchat.chatroom.ChatroomMember.Role;
import com.cipherchat.chatroom.ChatroomRepositories.Chatrooms;
import com.cipherchat.chatroom.ChatroomRepositories.Members;
import com.cipherchat.chatroom.ChatroomRepositories.Messages;
import com.cipherchat.chatroom.ChatroomRepositories.ReadStates;
import com.cipherchat.shared.api.ApiException;
import com.cipherchat.user.UserService;
import com.cipherchat.user.UserView;

/**
 * Rooms, membership and roles. This is the authorization authority for
 * rooms: every read/write of room content goes through {@link #assertAccess}.
 * Public rooms grant access to anyone (membership is recorded on first
 * participation); private rooms grant access to members only.
 */
@Service
@Transactional
public class ChatroomService {

    private static final Logger log = LoggerFactory.getLogger(ChatroomService.class);

    private final Chatrooms rooms;
    private final Members members;
    private final Messages messages;
    private final ReadStates readStates;
    private final UserService users;

    public ChatroomService(Chatrooms rooms, Members members, Messages messages, ReadStates readStates, UserService users) {
        this.rooms = rooms;
        this.members = members;
        this.messages = messages;
        this.readStates = readStates;
        this.users = users;
    }

    public RoomView create(UUID creatorId, String name, boolean privateRoom) {
        String trimmed = name.trim();
        if (rooms.findByNameIgnoringCase(trimmed).isPresent()) {
            throw ApiException.conflict("chatroom_exists", "Chatroom with that name already exists!");
        }
        Chatroom room = rooms.save(new Chatroom(trimmed, privateRoom, creatorId));
        members.save(new ChatroomMember(room.getId(), creatorId, Role.owner));
        log.info("Room created roomId={} by={} private={}", room.getId(), creatorId, privateRoom);
        return view(room, users.require(creatorId).name(), 1, Role.owner, 0);
    }

    /** Dashboard listing: visible rooms with member count, caller's role and unread badge — no N+1. */
    @Transactional(readOnly = true)
    public List<RoomView> listFor(UUID userId) {
        List<Chatroom> visible = rooms.findVisibleTo(userId);
        if (visible.isEmpty()) return List.of();
        Set<UUID> ids = visible.stream().map(Chatroom::getId).collect(Collectors.toSet());

        Map<UUID, Long> counts = new HashMap<>();
        for (Object[] row : members.countByRooms(ids)) counts.put((UUID) row[0], (Long) row[1]);
        Map<UUID, Role> myRoles = members.findAllByKeyUserIdAndKeyChatroomIdIn(userId, ids).stream()
                .collect(Collectors.toMap(ChatroomMember::getChatroomId, ChatroomMember::getRole));
        Map<UUID, Long> unreadByRoom = new HashMap<>();
        for (Object[] row : messages.unreadByRooms(userId, ids)) unreadByRoom.put((UUID) row[0], ((Number) row[1]).longValue());
        Map<UUID, UserView.Summary> creators = users.summaries(
                visible.stream().map(Chatroom::getCreatedBy).filter(java.util.Objects::nonNull).toList());

        return visible.stream().map(room -> {
            long unread = unreadByRoom.getOrDefault(room.getId(), 0L);   // one grouped query for the whole sidebar
            String creatorName = room.getCreatedBy() == null ? null
                    : Optional.ofNullable(creators.get(room.getCreatedBy())).map(UserView.Summary::name).orElse(null);
            return view(room, creatorName, counts.getOrDefault(room.getId(), 0L).intValue(), myRoles.get(room.getId()), unread);
        }).toList();
    }

    /** Throws 404/403; returns the room. The single access rule for room content. */
    @Transactional(readOnly = true)
    public Chatroom assertAccess(UUID roomId, UUID userId) {
        Chatroom room = rooms.findById(roomId)
                .orElseThrow(() -> ApiException.notFound("chatroom_not_found", "Chatroom not found."));
        if (room.isPrivateRoom() && members.findByKeyChatroomIdAndKeyUserId(roomId, userId).isEmpty()) {
            throw ApiException.forbidden("not_member", "This is a private room.");
        }
        return room;
    }

    @Transactional(readOnly = true)
    public Optional<Role> roleOf(UUID roomId, UUID userId) {
        return members.findByKeyChatroomIdAndKeyUserId(roomId, userId).map(ChatroomMember::getRole);
    }

    /** Public rooms: participation = membership. Idempotent. */
    public void ensureMembership(UUID roomId, UUID userId) {
        if (members.findByKeyChatroomIdAndKeyUserId(roomId, userId).isEmpty()) {
            members.save(new ChatroomMember(roomId, userId, Role.member));
        }
    }

    @Transactional(readOnly = true)
    public MembersView members(UUID roomId, UUID callerId) {
        Chatroom room = assertAccess(roomId, callerId);
        List<ChatroomMember> rows = members.findAllByKeyChatroomId(roomId);
        Map<UUID, UserView> people = users.views(rows.stream().map(ChatroomMember::getUserId).toList());
        List<MemberView> views = rows.stream()
                .filter(m -> people.containsKey(m.getUserId()))
                .map(m -> {
                    UserView u = people.get(m.getUserId());
                    return new MemberView(new UserView.Summary(u.id(), u.name(), u.dp()), u.email(), u.isOnline(),
                            m.getRole(), m.getJoinedAt());
                })
                .toList();
        return new MembersView(views, room.isPrivateRoom(), roleOf(roomId, callerId).orElse(null));
    }

    public String join(UUID roomId, UUID userId) {
        Chatroom room = assertAccess(roomId, userId);   // 403s on private non-member
        ensureMembership(roomId, userId);
        return room.getName();
    }

    public String invite(UUID roomId, UUID inviterId, UUID inviteeId) {
        assertAccess(roomId, inviterId);
        requireRole(roomId, inviterId, Role.owner, Role.admin);
        UserView invitee = users.require(inviteeId);
        if (roleOf(roomId, inviteeId).isPresent()) {
            throw ApiException.conflict("already_member", "User is already a member.");
        }
        members.save(new ChatroomMember(roomId, inviteeId, Role.member));
        log.info("Room invite roomId={} invitee={} by={}", roomId, inviteeId, inviterId);
        return invitee.name();
    }

    public void leave(UUID roomId, UUID userId) {
        assertAccess(roomId, userId);
        Role role = roleOf(roomId, userId)
                .orElseThrow(() -> ApiException.badRequest("not_member", "You are not a member of this room."));
        if (role == Role.owner) {
            throw ApiException.badRequest("owner_cannot_leave", "Owners must transfer ownership before leaving.");
        }
        members.remove(roomId, userId);
    }

    /** Owner only. Promoting someone to owner transfers ownership (previous owner → admin). */
    public void changeRole(UUID roomId, UUID actorId, UUID targetId, Role role) {
        assertAccess(roomId, actorId);
        requireRole(roomId, actorId, Role.owner);
        if (targetId.equals(actorId)) throw ApiException.badRequest("self_role", "You cannot change your own role.");
        if (roleOf(roomId, targetId).isEmpty()) throw ApiException.notFound("not_member", "That user is not a member.");
        if (role == Role.owner) {
            members.setRole(roomId, actorId, Role.admin);
        }
        members.setRole(roomId, targetId, role);
        log.info("Room role updated roomId={} target={} role={} by={}", roomId, targetId, role, actorId);
    }

    private void requireRole(UUID roomId, UUID userId, Role... allowed) {
        Role role = roleOf(roomId, userId).orElse(null);
        for (Role r : allowed) if (r == role) return;
        throw ApiException.forbidden("insufficient_role", "You need to be " + String.join(" or ", java.util.Arrays.stream(allowed).map(Enum::name).toList()) + ".");
    }

    Collection<UUID> memberIds(UUID roomId) {
        return members.findAllByKeyChatroomId(roomId).stream().map(ChatroomMember::getUserId).toList();
    }

    private static RoomView view(Chatroom r, String creatorName, int memberCount, Role myRole, long unread) {
        return new RoomView(r.getId().toString(), r.getName(), r.isPrivateRoom(),
                r.getCreatedBy() == null ? null : r.getCreatedBy().toString(), creatorName,
                memberCount, myRole, unread, r.getCreatedAt());
    }
}
