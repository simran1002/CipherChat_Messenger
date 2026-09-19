package com.cipherchat.presence.crdt;

/**
 * A Hybrid Logical Clock timestamp: {@code (physical, logical, replicaId)}, totally ordered
 * lexicographically. Two timestamps compare by wall-clock time first, then by the logical counter that
 * disambiguates events the physical clock can't tell apart, then by replica id as a last-resort
 * tiebreak between two truly concurrent, independently-generated timestamps.
 *
 * <p>Why not a raw wall-clock {@code Instant}? A plain last-write-wins register compares physical clocks
 * alone, so a message that causally happened AFTER another (region B received region A's update and then
 * wrote its own) can still lose to it if B's clock merely reads earlier than A's — clock skew silently
 * reorders history. HLC fixes this: {@link HybridLogicalClock#update} folds the remote timestamp into the
 * local clock, so a causally-later event is provably assigned a greater HLC timestamp regardless of clock
 * skew, while the physical component keeps timestamps close to wall-clock time for humans and TTLs.
 */
public record HlcTimestamp(long physical, long logical, String replicaId) implements Comparable<HlcTimestamp> {

    @Override
    public int compareTo(HlcTimestamp other) {
        int byPhysical = Long.compare(physical, other.physical);
        if (byPhysical != 0) return byPhysical;
        int byLogical = Long.compare(logical, other.logical);
        if (byLogical != 0) return byLogical;
        return replicaId.compareTo(other.replicaId);
    }

    /** True happens-before: this could be a cause of {@code other} (equal or earlier, same total order). */
    public boolean happensBeforeOrEquals(HlcTimestamp other) {
        return compareTo(other) <= 0;
    }
}
