package com.cipherchat.chatroom;

import java.io.Serializable;
import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;

import org.hibernate.annotations.CreationTimestamp;

@Entity
@Table(name = "message_reactions")
public class MessageReaction {

    @Embeddable
    public record Key(@Column(name = "message_id") Long messageId,
                      @Column(name = "user_id") UUID userId,
                      @Column(length = 16) String emoji) implements Serializable {
    }

    @EmbeddedId
    private Key key;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    protected MessageReaction() {
    }

    MessageReaction(Long messageId, UUID userId, String emoji) {
        this.key = new Key(messageId, userId, emoji);
    }

    public Key getKey() { return key; }
    public Long getMessageId() { return key.messageId(); }
    public UUID getUserId() { return key.userId(); }
    public String getEmoji() { return key.emoji(); }
}
