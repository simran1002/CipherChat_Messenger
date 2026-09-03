package com.cipherchat.chatroom;

import java.io.Serializable;
import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Table;

import org.hibernate.annotations.CreationTimestamp;

@Entity
@Table(name = "chatroom_members")
public class ChatroomMember {

    public enum Role { owner, admin, member }

    @Embeddable
    public record Key(@Column(name = "chatroom_id") UUID chatroomId, @Column(name = "user_id") UUID userId)
            implements Serializable {
    }

    @EmbeddedId
    private Key key;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 10)
    private Role role = Role.member;

    @CreationTimestamp
    @Column(name = "joined_at", nullable = false, updatable = false)
    private Instant joinedAt;

    protected ChatroomMember() {
    }

    ChatroomMember(UUID chatroomId, UUID userId, Role role) {
        this.key = new Key(chatroomId, userId);
        this.role = role;
    }

    public UUID getChatroomId() { return key.chatroomId(); }
    public UUID getUserId() { return key.userId(); }
    public Role getRole() { return role; }
    public Instant getJoinedAt() { return joinedAt; }
    void setRole(Role role) { this.role = role; }

    @Override
    public boolean equals(Object o) {
        return o instanceof ChatroomMember m && Objects.equals(key, m.key);
    }

    @Override
    public int hashCode() {
        return Objects.hashCode(key);
    }
}
