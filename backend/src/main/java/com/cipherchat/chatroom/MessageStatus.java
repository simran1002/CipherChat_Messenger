package com.cipherchat.chatroom;

import java.io.Serializable;
import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;

/** Per-(message, user) delivery/read receipt. Writes are idempotent upserts — see {@link MessageStatusRepository}. */
@Entity
@Table(name = "message_status")
public class MessageStatus {

    @Embeddable
    public record Key(@Column(name = "message_id") Long messageId, @Column(name = "user_id") UUID userId)
            implements Serializable {
    }

    @EmbeddedId
    private Key key;

    @Column(name = "delivered_at") private Instant deliveredAt;
    @Column(name = "read_at") private Instant readAt;

    protected MessageStatus() {
    }

    public Long getMessageId() { return key.messageId(); }
    public UUID getUserId() { return key.userId(); }
    public Instant getDeliveredAt() { return deliveredAt; }
    public Instant getReadAt() { return readAt; }
}
