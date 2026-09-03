package com.cipherchat.chatroom;

import java.io.Serializable;
import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;

import org.hibernate.annotations.UpdateTimestamp;

/** Per-user, per-room read watermark; the unread badge is one indexed range count above it. */
@Entity
@Table(name = "room_read_state")
public class RoomReadState {

    @Embeddable
    public record Key(@Column(name = "user_id") UUID userId, @Column(name = "chatroom_id") UUID chatroomId)
            implements Serializable {
    }

    @EmbeddedId
    private Key key;

    @Column(name = "last_read_sequence", nullable = false)
    private long lastReadSequence;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected RoomReadState() {
    }

    public UUID getUserId() { return key.userId(); }
    public UUID getChatroomId() { return key.chatroomId(); }
    public long getLastReadSequence() { return lastReadSequence; }
}
