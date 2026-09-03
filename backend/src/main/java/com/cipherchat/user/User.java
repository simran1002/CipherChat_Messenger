package com.cipherchat.user;

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
import jakarta.persistence.Version;

import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

@Entity
@Table(name = "users")
public class User {

    public enum Role { USER, ADMIN }

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false, length = 50)
    private String name;

    /** Stored lowercased; the unique index is on lower(email). */
    @Column(nullable = false, length = 254)
    private String email;

    @Column(name = "password_hash", nullable = false, length = 100)
    private String passwordHash;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private Role role = Role.USER;

    @Column(nullable = false)
    private String dp = "";

    @Column(nullable = false, length = 160)
    private String bio = "";

    @Column(name = "presence_status", nullable = false, length = 20)
    private PresenceStatus presenceStatus = PresenceStatus.AVAILABLE;

    @Column(name = "presence_note", nullable = false, length = 80)
    private String presenceNote = "";

    @Column(name = "is_online", nullable = false)
    private boolean online;

    @Column(name = "last_seen")
    private Instant lastSeen;

    /** Optimistic locking: concurrent profile edits fail fast instead of last-write-wins. */
    @Version
    @Column(nullable = false)
    private long version;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected User() {
    }

    public User(String name, String email, String passwordHash) {
        this.name = name;
        this.email = email.toLowerCase();
        this.passwordHash = passwordHash;
    }

    public UUID getId() { return id; }
    public String getName() { return name; }
    public String getEmail() { return email; }
    public String getPasswordHash() { return passwordHash; }
    public Role getRole() { return role; }
    public String getDp() { return dp; }
    public String getBio() { return bio; }
    public PresenceStatus getPresenceStatus() { return presenceStatus; }
    public String getPresenceNote() { return presenceNote; }
    public boolean isOnline() { return online; }
    public Instant getLastSeen() { return lastSeen; }
    public long getVersion() { return version; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    public void rename(String name) { this.name = name; }
    public void setBio(String bio) { this.bio = bio; }
    public void setDp(String dp) { this.dp = dp; }
    public void changePassword(String newHash) { this.passwordHash = newHash; }
    public void setPresence(PresenceStatus status, String note) {
        if (status != null) this.presenceStatus = status;
        if (note != null) this.presenceNote = note;
    }
    public void markOnline() { this.online = true; }
    public void markOffline(Instant at) { this.online = false; this.lastSeen = at; }
}
