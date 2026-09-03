package com.cipherchat.auth;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

@Entity
@Table(name = "two_factor")
public class TwoFactor {

    @Id
    @Column(name = "user_id")
    private UUID userId;

    @Column(nullable = false)
    private boolean enabled;

    /** Base32 TOTP seed, AES-GCM sealed (see {@link SecretBox}). */
    @Column(name = "secret_sealed", nullable = false)
    private String secretSealed;

    /** BCrypt hashes of single-use backup codes; a used code is removed. */
    @JdbcTypeCode(SqlTypes.ARRAY)
    @Column(name = "backup_codes", nullable = false, columnDefinition = "text[]")
    private String[] backupCodes = new String[0];

    @Column(name = "enabled_at")
    private Instant enabledAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected TwoFactor() {
    }

    TwoFactor(UUID userId, String secretSealed) {
        this.userId = userId;
        this.secretSealed = secretSealed;
    }

    public UUID getUserId() { return userId; }
    public boolean isEnabled() { return enabled; }
    public String getSecretSealed() { return secretSealed; }
    public String[] getBackupCodes() { return backupCodes; }
    public Instant getEnabledAt() { return enabledAt; }

    void enable(String[] hashedBackupCodes) {
        this.enabled = true;
        this.enabledAt = Instant.now();
        this.backupCodes = hashedBackupCodes;
    }

    void setBackupCodes(String[] codes) {
        this.backupCodes = codes;
    }
}
