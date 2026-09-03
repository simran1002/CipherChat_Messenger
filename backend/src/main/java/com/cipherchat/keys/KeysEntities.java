package com.cipherchat.keys;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import org.hibernate.annotations.UpdateTimestamp;

final class KeysEntities {

    private KeysEntities() {
    }

    @Entity
    @Table(name = "user_keys")
    static class UserKeys {
        @Id @Column(name = "user_id") UUID userId;
        @Column(name = "identity_ed25519", nullable = false) String identityEd25519;
        @Column(name = "identity_x25519", nullable = false) String identityX25519;
        @Column(name = "spk_key_id", nullable = false) int spkKeyId;
        @Column(name = "spk_pub_x25519", nullable = false) String spkPubX25519;
        @Column(name = "spk_sig", nullable = false) String spkSig;
        @Column(name = "key_version", nullable = false) int keyVersion = 1;
        @Column(name = "published_at", nullable = false) Instant publishedAt = Instant.now();

        protected UserKeys() {
        }
    }

    @Entity
    @Table(name = "key_backups")
    static class KeyBackup {
        @Id @Column(name = "user_id") UUID userId;
        @Column(nullable = false) String blob;
        @UpdateTimestamp @Column(name = "updated_at", nullable = false) Instant updatedAt;

        protected KeyBackup() {
        }
    }
}
