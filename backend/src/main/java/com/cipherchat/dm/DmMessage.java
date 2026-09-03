package com.cipherchat.dm;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Converter;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

/**
 * One direct message. {@code type} discriminates the two shapes:
 * {@code e2ee/v1} (content is an opaque envelope) and
 * {@code plaintext-legacy} (pre-E2EE history, content in {@code body}).
 */
@Entity
@Table(name = "dm_messages")
public class DmMessage {

    public enum Type {
        E2EE_V1("e2ee/v1"), PLAINTEXT_LEGACY("plaintext-legacy");

        private final String value;
        Type(String value) { this.value = value; }

        @com.fasterxml.jackson.annotation.JsonValue
        public String value() { return value; }

        public static Type from(String v) {
            for (Type t : values()) if (t.value.equals(v)) return t;
            throw new IllegalArgumentException("Unknown DM type " + v);
        }

        @Converter(autoApply = true)
        public static class Jpa implements AttributeConverter<Type, String> {
            @Override public String convertToDatabaseColumn(Type t) { return t == null ? null : t.value; }
            @Override public Type convertToEntityAttribute(String s) { return s == null ? null : from(s); }
        }
    }

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "conversation_id", nullable = false)
    private UUID conversationId;

    @Column(name = "sender_id", nullable = false)
    private UUID senderId;

    @Column(name = "client_message_id")
    private UUID clientMessageId;

    @Convert(converter = Type.Jpa.class)
    @Column(nullable = false, length = 20)
    private Type type;

    @Column(nullable = false, length = 2000)
    private String body = "";

    /** The E2EE envelope as stored — JSONB, indexed on sessionId/ctr for the replay backstop. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private Map<String, Object> envelope;

    @Column(nullable = false)
    private boolean edited;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    protected DmMessage() {
    }

    static DmMessage encrypted(UUID conversationId, UUID senderId, UUID clientMessageId, Map<String, Object> envelope) {
        DmMessage m = new DmMessage();
        m.conversationId = conversationId;
        m.senderId = senderId;
        m.clientMessageId = clientMessageId;
        m.type = Type.E2EE_V1;
        m.envelope = envelope;
        return m;
    }

    static DmMessage plaintext(UUID conversationId, UUID senderId, UUID clientMessageId, String body) {
        DmMessage m = new DmMessage();
        m.conversationId = conversationId;
        m.senderId = senderId;
        m.clientMessageId = clientMessageId;
        m.type = Type.PLAINTEXT_LEGACY;
        m.body = body;
        return m;
    }

    public Long getId() { return id; }
    public UUID getConversationId() { return conversationId; }
    public UUID getSenderId() { return senderId; }
    public UUID getClientMessageId() { return clientMessageId; }
    public Type getType() { return type; }
    public String getBody() { return body; }
    public Map<String, Object> getEnvelope() { return envelope; }
    public boolean isEdited() { return edited; }
    public Instant getCreatedAt() { return createdAt; }
}
