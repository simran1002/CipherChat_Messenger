package com.cipherchat.dm;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import org.hibernate.annotations.CreationTimestamp;

/** Exactly two participants, stored as an ordered pair so (a,b) and (b,a) are the same row. */
@Entity
@Table(name = "conversations")
public class Conversation {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_low", nullable = false)
    private UUID userLow;

    @Column(name = "user_high", nullable = false)
    private UUID userHigh;

    @Column(name = "last_message_at", nullable = false)
    private Instant lastMessageAt = Instant.now();

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    protected Conversation() {
    }

    static Conversation between(UUID a, UUID b) {
        Conversation c = new Conversation();
        int cmp = compareUnsigned(a, b);
        c.userLow = cmp < 0 ? a : b;
        c.userHigh = cmp < 0 ? b : a;
        return c;
    }

    /**
     * PostgreSQL orders UUIDs as unsigned bytes; {@link UUID#compareTo} compares signed longs, so
     * the two disagree whenever the high bit of either half differs — about half of all pairs.
     * The CHECK (user_low < user_high) is evaluated by the database, so the database's order wins.
     * The canonical lower-case hex string sorts exactly like the unsigned bytes.
     */
    static int compareUnsigned(UUID a, UUID b) {
        return a.toString().compareTo(b.toString());
    }

    public UUID getId() { return id; }
    public UUID getUserLow() { return userLow; }
    public UUID getUserHigh() { return userHigh; }
    public Instant getLastMessageAt() { return lastMessageAt; }
    public Instant getCreatedAt() { return createdAt; }

    public boolean has(UUID userId) {
        return userLow.equals(userId) || userHigh.equals(userId);
    }

    public UUID other(UUID userId) {
        return userLow.equals(userId) ? userHigh : userLow;
    }

    void touch(Instant at) {
        if (at.isAfter(lastMessageAt)) lastMessageAt = at;
    }
}
