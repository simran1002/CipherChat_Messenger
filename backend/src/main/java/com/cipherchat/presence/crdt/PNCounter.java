package com.cipherchat.presence.crdt;

/**
 * Increment/decrement counter built from two {@link GCounter}s (Shapiro et al., "A comprehensive study
 * of CRDTs", 2011) — the standard construction, since a single grow-only counter can't represent "went
 * down". Value is {@code increments.value() - decrements.value()}; merge is each half merged
 * independently, which stays a join-semilattice because each half is one.
 *
 * <p>The motivating case in this codebase: {@code PresenceRegistry}'s {@code sessions} count today is a
 * single Redis {@code HINCRBY}, safe because there is exactly one writer (one Redis instance). Split
 * across regions with no shared Redis, two regions incrementing and decrementing a user's session count
 * concurrently can't use a shared counter at all — this is the type that lets each region apply its own
 * connects/disconnects locally and converge on the true global count once the regions exchange state,
 * regardless of the order or how many times a given update is re-delivered.
 */
public final class PNCounter {

    private final GCounter increments;
    private final GCounter decrements;

    public static PNCounter zero() {
        return new PNCounter(GCounter.empty(), GCounter.empty());
    }

    private PNCounter(GCounter increments, GCounter decrements) {
        this.increments = increments;
        this.decrements = decrements;
    }

    public PNCounter increment(String replicaId, long delta) {
        return new PNCounter(increments.increment(replicaId, delta), decrements);
    }

    public PNCounter decrement(String replicaId, long delta) {
        return new PNCounter(increments, decrements.increment(replicaId, delta));
    }

    public PNCounter merge(PNCounter other) {
        return new PNCounter(increments.merge(other.increments), decrements.merge(other.decrements));
    }

    public long value() {
        return increments.value() - decrements.value();
    }
}
