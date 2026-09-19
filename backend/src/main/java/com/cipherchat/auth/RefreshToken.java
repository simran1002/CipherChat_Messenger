package com.cipherchat.auth;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import org.hibernate.annotations.CreationTimestamp;

/** One row per live session — see {@link RefreshTokenService} for the rotation protocol. */
@Entity
@Table(name = "refresh_tokens")
public class RefreshToken {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "token_hash", nullable = false, length = 64, unique = true)
    private String tokenHash;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "created_by_ip", nullable = false, length = 45)
    private String createdByIp = "";

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    /** Every token minted from one sign-in shares a family; reuse of any member revokes all of them. */
    @Column(name = "family_id", nullable = false, updatable = false)
    private UUID familyId;

    /** Set when the token is rotated. A used token that shows up again is the theft signal. */
    @Column(name = "used_at")
    private Instant usedAt;

    protected RefreshToken() {
    }

    RefreshToken(UUID userId, String tokenHash, Instant expiresAt, String createdByIp, UUID familyId) {
        this.userId = userId;
        this.tokenHash = tokenHash;
        this.expiresAt = expiresAt;
        this.createdByIp = createdByIp == null ? "" : createdByIp;
        this.familyId = familyId;
    }

    public UUID getId() { return id; }
    public UUID getUserId() { return userId; }
    public String getTokenHash() { return tokenHash; }
    public Instant getExpiresAt() { return expiresAt; }
    public String getCreatedByIp() { return createdByIp; }
    public Instant getCreatedAt() { return createdAt; }
    public UUID getFamilyId() { return familyId; }
    public Instant getUsedAt() { return usedAt; }
}
