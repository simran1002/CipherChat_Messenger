package com.cipherchat.audit;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import com.cipherchat.shared.events.AuditEvents.Audited;

@Entity
@Table(name = "audit_logs")
public class AuditLog {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "actor_id")
    private UUID actorId;

    @Column(nullable = false, length = 50)
    private String action;

    @Column(name = "target_type", length = 30)
    private String targetType;

    @Column(name = "target_id", length = 64)
    private String targetId;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private Map<String, Object> metadata = Map.of();

    @Column(nullable = false, length = 45)
    private String ip = "";

    /** The producer's timestamp, not the consumer's — audit order must survive Kafka lag. */
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    protected AuditLog() {
    }

    static AuditLog from(Audited e) {
        AuditLog a = new AuditLog();
        a.actorId = e.actorId();
        a.action = e.action();
        a.targetType = e.targetType();
        a.targetId = e.targetId();
        a.metadata = e.metadata();
        a.ip = e.ip() == null ? "" : e.ip();
        a.createdAt = e.occurredAt();
        return a;
    }

    public Long getId() { return id; }
    public UUID getActorId() { return actorId; }
    public String getAction() { return action; }
    public String getTargetType() { return targetType; }
    public String getTargetId() { return targetId; }
    public Map<String, Object> getMetadata() { return metadata; }
    public String getIp() { return ip; }
    public Instant getCreatedAt() { return createdAt; }
}
