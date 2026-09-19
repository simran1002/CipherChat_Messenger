package com.cipherchat.presence.crdt;

import java.util.function.LongSupplier;

/**
 * Per-replica Hybrid Logical Clock (Kulkarni et al., "Logical Physical Clocks", 2014) — the same family
 * of clock CockroachDB and MongoDB use to order distributed writes without a coordinator.
 *
 * <p>Two operations, corresponding to the two events a clock needs to handle:
 * <ul>
 *   <li>{@link #now()} — a local event (this replica is about to write something). Advances past the
 *       physical clock and this clock's own history.</li>
 *   <li>{@link #update(HlcTimestamp)} — a receive event (this replica just learned of a remote
 *       timestamp). Advances past the physical clock, this clock's own history, AND the remote
 *       timestamp, so anything timestamped afterwards is provably ordered after the remote event —
 *       this is what makes an {@link LwwRegister} resolve concurrent writes correctly under clock skew
 *       instead of merely by whichever server's clock happens to read later.</li>
 * </ul>
 *
 * <p>One instance per replica (region/pod); {@code replicaId} must be unique across the whole
 * deployment. Thread-safe: a JVM handling concurrent presence updates for many users shares one clock.
 */
public final class HybridLogicalClock {

    private final String replicaId;
    private final LongSupplier physicalClock;
    private long l; // highest physical time this clock has witnessed, local or remote
    private long c; // logical counter disambiguating events sharing that physical time

    public HybridLogicalClock(String replicaId) {
        this(replicaId, System::currentTimeMillis);
    }

    /** Test seam: inject a fake wall clock to exercise clock-skew and non-monotonic-time scenarios. */
    HybridLogicalClock(String replicaId, LongSupplier physicalClock) {
        this.replicaId = replicaId;
        this.physicalClock = physicalClock;
    }

    public synchronized HlcTimestamp now() {
        long pt = physicalClock.getAsLong();
        long lNew = Math.max(l, pt);
        c = (lNew == l) ? c + 1 : 0;
        l = lNew;
        return new HlcTimestamp(l, c, replicaId);
    }

    public synchronized HlcTimestamp update(HlcTimestamp remote) {
        long pt = physicalClock.getAsLong();
        long lNew = Math.max(Math.max(l, remote.physical()), pt);
        if (lNew == l && lNew == remote.physical()) {
            c = Math.max(c, remote.logical()) + 1;
        } else if (lNew == l) {
            c = c + 1;
        } else if (lNew == remote.physical()) {
            c = remote.logical() + 1;
        } else {
            c = 0;
        }
        l = lNew;
        return new HlcTimestamp(l, c, replicaId);
    }
}
