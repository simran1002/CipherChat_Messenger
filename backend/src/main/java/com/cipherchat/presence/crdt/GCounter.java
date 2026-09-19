package com.cipherchat.presence.crdt;

import java.util.HashMap;
import java.util.Map;

/**
 * Grow-only counter — the building block {@link PNCounter} is made of. One slot per replica; a replica
 * may only ever increase its OWN slot, never another's and never downward, which is exactly what makes
 * {@link #merge} (pointwise maximum) always converge regardless of delivery order: {@code max} is
 * commutative, associative and idempotent by construction, so this forms a join-semilattice — the
 * formal property a CRDT has to have. Those three laws are asserted directly in {@code GCounterTest}
 * rather than assumed.
 *
 * <p>Immutable value type: every operation returns a new instance, mirroring the "commit produces the
 * next state" style already used for ratchet state on the client ({@code doubleRatchet.ts}) rather than
 * mutating shared state in place.
 */
public final class GCounter {

    private final Map<String, Long> counts;

    public static GCounter empty() {
        return new GCounter(Map.of());
    }

    private GCounter(Map<String, Long> counts) {
        this.counts = counts;
    }

    /** This replica's own contribution goes up by {@code delta} (must be non-negative — growth only). */
    public GCounter increment(String replicaId, long delta) {
        if (delta < 0) throw new IllegalArgumentException("GCounter only grows: delta must be >= 0, got " + delta);
        Map<String, Long> next = new HashMap<>(counts);
        next.merge(replicaId, delta, Long::sum);
        return new GCounter(next);
    }

    /** Pointwise maximum per replica slot — safe to apply in any order, any number of times. */
    public GCounter merge(GCounter other) {
        Map<String, Long> next = new HashMap<>(counts);
        other.counts.forEach((replicaId, value) -> next.merge(replicaId, value, Math::max));
        return new GCounter(next);
    }

    public long value() {
        return counts.values().stream().mapToLong(Long::longValue).sum();
    }

    Map<String, Long> slots() {
        return counts;
    }
}
