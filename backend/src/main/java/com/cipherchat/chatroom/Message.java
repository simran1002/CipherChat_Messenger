package com.cipherchat.chatroom;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

/**
 * A room message. Reactions and per-user receipts are separate tables (they
 * are written by many users concurrently; embedding them would make every
 * reaction a full-row rewrite under optimistic contention).
 */
@Entity
@Table(name = "messages")
public class Message {

    public enum Type { text, image, audio, file, location }

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "chatroom_id", nullable = false)
    private UUID chatroomId;

    @Column(name = "sender_id", nullable = false)
    private UUID senderId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 10)
    private Type type = Type.text;

    @Column(nullable = false, length = 2000)
    private String body = "";

    @Column(name = "file_url") private String fileUrl;
    @Column(name = "file_name") private String fileName;
    @Column(name = "mime_type") private String mimeType;
    @Column(name = "file_size") private Long fileSize;
    private Double lat;
    private Double lng;

    @Column(name = "reply_to_id") private Long replyToId;
    @Column(name = "reply_preview", length = 200) private String replyPreview;
    @Column(name = "reply_sender_name", length = 50) private String replySenderName;

    @JdbcTypeCode(SqlTypes.ARRAY)
    @Column(nullable = false, columnDefinition = "uuid[]")
    private UUID[] mentions = new UUID[0];

    @Column(nullable = false) private boolean pinned;
    @Column(nullable = false) private boolean edited;

    @Column(name = "expires_at") private Instant expiresAt;

    @Column(name = "client_message_id") private UUID clientMessageId;

    @Column(name = "sequence_number", nullable = false)
    private long sequenceNumber;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected Message() {
    }

    Message(UUID chatroomId, UUID senderId, Type type, String body, long sequenceNumber, UUID clientMessageId) {
        this.chatroomId = chatroomId;
        this.senderId = senderId;
        this.type = type;
        this.body = body == null ? "" : body;
        this.sequenceNumber = sequenceNumber;
        this.clientMessageId = clientMessageId;
    }

    public Long getId() { return id; }
    public UUID getChatroomId() { return chatroomId; }
    public UUID getSenderId() { return senderId; }
    public Type getType() { return type; }
    public String getBody() { return body; }
    public String getFileUrl() { return fileUrl; }
    public String getFileName() { return fileName; }
    public String getMimeType() { return mimeType; }
    public Long getFileSize() { return fileSize; }
    public Double getLat() { return lat; }
    public Double getLng() { return lng; }
    public Long getReplyToId() { return replyToId; }
    public String getReplyPreview() { return replyPreview; }
    public String getReplySenderName() { return replySenderName; }
    public UUID[] getMentions() { return mentions; }
    public boolean isPinned() { return pinned; }
    public boolean isEdited() { return edited; }
    public Instant getExpiresAt() { return expiresAt; }
    public UUID getClientMessageId() { return clientMessageId; }
    public long getSequenceNumber() { return sequenceNumber; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    void attachFile(String url, String name, String mime, Long size) {
        this.fileUrl = url; this.fileName = name; this.mimeType = mime; this.fileSize = size;
    }
    void locate(Double lat, Double lng) { this.lat = lat; this.lng = lng; }
    void replyTo(Long messageId, String preview, String senderName) {
        this.replyToId = messageId;
        this.replyPreview = preview == null ? null : preview.substring(0, Math.min(200, preview.length()));
        this.replySenderName = senderName;
    }
    void mention(UUID[] ids) { this.mentions = ids == null ? new UUID[0] : ids; }
    void expireAt(Instant at) { this.expiresAt = at; }
    void edit(String newBody) { this.body = newBody; this.edited = true; }
    void togglePin() { this.pinned = !this.pinned; }
}
