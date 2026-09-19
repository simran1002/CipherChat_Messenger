package com.cipherchat.presence.crdt;

import java.util.Objects;
import java.util.UUID;

import com.cipherchat.user.PresenceStatus;

/**
 * Worked example composing {@link PNCounter} and {@link LwwRegister} into the shape
 * {@code PresenceRegistry.Entry} already has: how many live sessions a user has, and their status/note —
 * demonstrating exactly what a multi-region presence merge would look like on top of these primitives.
 * A join-semilattice composed of join-semilattices is itself one, so {@link #merge} inherits
 * commutativity, associativity and idempotence from its two fields without needing its own proof.
 *
 * <p>Not wired into {@link com.cipherchat.presence.PresenceRegistry}: today's single Redis instance IS
 * the one source of truth, so there is no concurrent-writer problem for this to solve yet. This class is
 * what would replace the naive "last HSET wins" merge if that single instance became several.
 */
public final class ReplicatedPresence {

    public record StatusNote(PresenceStatus status, String note) {
    }

    private final UUID userId;
    private final PNCounter sessions;
    private final LwwRegister<StatusNote> status;

    public static ReplicatedPresence firstConnect(UUID userId, String replicaId, HlcTimestamp timestamp, StatusNote initial) {
        return new ReplicatedPresence(userId, PNCounter.zero().increment(replicaId, 1), LwwRegister.initial(initial, timestamp));
    }

    private ReplicatedPresence(UUID userId, PNCounter sessions, LwwRegister<StatusNote> status) {
        this.userId = userId;
        this.sessions = sessions;
        this.status = status;
    }

    public ReplicatedPresence connect(String replicaId) {
        return new ReplicatedPresence(userId, sessions.increment(replicaId, 1), status);
    }

    public ReplicatedPresence disconnect(String replicaId) {
        return new ReplicatedPresence(userId, sessions.decrement(replicaId, 1), status);
    }

    public ReplicatedPresence updateStatus(StatusNote value, HlcTimestamp timestamp) {
        return new ReplicatedPresence(userId, sessions, status.set(value, timestamp));
    }

    /** Session count is clamped at zero for display: a replica that only ever saw disconnects for a user
     *  it never saw connect (a late-joining region backfilling history) must not report a negative
     *  crowd of sessions while the merge is still catching up. */
    public boolean isOnline() {
        return sessions.value() > 0;
    }

    public long sessionCount() {
        return sessions.value();
    }

    public StatusNote status() {
        return status.value();
    }

    public ReplicatedPresence merge(ReplicatedPresence other) {
        if (!userId.equals(other.userId)) {
            throw new IllegalArgumentException("Cannot merge presence for different users: " + userId + " vs " + other.userId);
        }
        return new ReplicatedPresence(userId, sessions.merge(other.sessions), status.merge(other.status));
    }

    /** Value equality on the externally observable state (session count, status) — not on internal
     *  per-replica CRDT bookkeeping, which two convergent-but-differently-assembled instances may hold
     *  differently while still being equal in every way that matters. */
    @Override
    public boolean equals(Object o) {
        return o instanceof ReplicatedPresence p
                && userId.equals(p.userId) && sessionCount() == p.sessionCount() && status().equals(p.status());
    }

    @Override
    public int hashCode() {
        return Objects.hash(userId, sessionCount(), status());
    }
}
