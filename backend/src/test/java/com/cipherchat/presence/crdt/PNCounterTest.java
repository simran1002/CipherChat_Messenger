package com.cipherchat.presence.crdt;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class PNCounterTest {

    @Test
    void valueIsIncrementsMinusDecrements() {
        var counter = PNCounter.zero().increment("a", 5).decrement("a", 2);
        assertThat(counter.value()).isEqualTo(3);
    }

    @Test
    void mergeIsCommutativeAssociativeAndIdempotent() {
        var a = PNCounter.zero().increment("a", 3).decrement("a", 1);
        var b = PNCounter.zero().increment("b", 5).decrement("b", 4);
        var c = PNCounter.zero().increment("c", 2);

        assertThat(a.merge(b).value()).isEqualTo(b.merge(a).value());
        assertThat(a.merge(b).merge(c).value()).isEqualTo(a.merge(b.merge(c)).value());
        assertThat(a.merge(a).value()).isEqualTo(a.value());
    }

    /**
     * The motivating scenario: two regions, no shared Redis, a network partition between them. Each
     * applies its own users' connects/disconnects locally with zero coordination. When the partition
     * heals, both sides must agree on the true global session count — and it must not matter which side
     * merges first, or whether a state gets re-delivered (at-least-once transport, same as everywhere
     * else in this codebase).
     */
    @Test
    void twoRegionsIndependentlyTrackSessionsDuringAPartitionAndConvergeOnceMerged() {
        // Region A: this user connects on two devices, then closes one.
        var regionA = PNCounter.zero().increment("region-a", 1).increment("region-a", 1).decrement("region-a", 1);
        // Region B, concurrently, unaware of A: the SAME user's mobile app connects once.
        var regionB = PNCounter.zero().increment("region-b", 1);

        long converged = regionA.merge(regionB).value();
        assertThat(converged).isEqualTo(2); // 1 live session on A + 1 on B

        // Order doesn't matter...
        assertThat(regionB.merge(regionA).value()).isEqualTo(2);
        // ...and neither does a duplicate delivery of the same region's state (idempotent merge).
        assertThat(regionA.merge(regionB).merge(regionB).value()).isEqualTo(2);
    }
}
