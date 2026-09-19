package com.cipherchat.presence.crdt;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.atomic.AtomicLong;

import org.junit.jupiter.api.Test;

class HybridLogicalClockTest {

    @Test
    void eachLocalEventStrictlyAdvances_evenWhenTheWallClockDoesNotMove() {
        AtomicLong fakeWallClock = new AtomicLong(1_000);
        var clock = new HybridLogicalClock("replica-a", fakeWallClock::get);

        var t1 = clock.now();
        var t2 = clock.now(); // wall clock unchanged: the logical counter must carry the ordering
        var t3 = clock.now();

        assertThat(t1).isLessThan(t2);
        assertThat(t2).isLessThan(t3);
        assertThat(t1.physical()).isEqualTo(1_000);
        assertThat(t2.logical()).isEqualTo(t1.logical() + 1);
    }

    @Test
    void theLogicalCounterResetsOnceThePhysicalClockActuallyAdvancesPastIt() {
        AtomicLong fakeWallClock = new AtomicLong(1_000);
        var clock = new HybridLogicalClock("replica-a", fakeWallClock::get);
        clock.now();
        clock.now();

        fakeWallClock.set(2_000);
        var t = clock.now();

        assertThat(t.physical()).isEqualTo(2_000);
        assertThat(t.logical()).isZero();
    }

    @Test
    void aReceiveEventJumpsPastBothTheLocalAndTheRemoteTimestamp() {
        AtomicLong fakeWallClock = new AtomicLong(1_000);
        var clock = new HybridLogicalClock("replica-b", fakeWallClock::get);
        var remote = new HlcTimestamp(5_000, 3, "replica-a"); // remote is "ahead" of this replica's wall clock

        var t = clock.update(remote);

        assertThat(t).isGreaterThan(remote);
        assertThat(t.physical()).isEqualTo(5_000);
        assertThat(t.logical()).isEqualTo(4);
    }

    /**
     * The property that makes HLC-backed LWW correct under clock skew: replica B's wall clock reads
     * BEHIND replica A's, so a naive last-write-wins register comparing raw wall-clock time would let
     * A's write beat B's — even though B's write causally happened after B received A's message. HLC
     * must never let that happen: any timestamp B produces after folding in A's must compare greater.
     */
    @Test
    void aCausallyLaterEventOutranksAnEarlierEventFromASkewedClock_evenThoughItsRawWallClockReadsEarlier() {
        AtomicLong clockOnA = new AtomicLong(10_000); // A's wall clock is AHEAD
        AtomicLong clockOnB = new AtomicLong(1_000); // B's wall clock is BEHIND — classic skew
        var a = new HybridLogicalClock("replica-a", clockOnA::get);
        var b = new HybridLogicalClock("replica-b", clockOnB::get);

        HlcTimestamp fromA = a.now();
        // B receives A's message (carrying fromA) and, in response, makes its own write.
        HlcTimestamp fromB = b.update(fromA);

        assertThat(fromB).isGreaterThan(fromA);
        // B's HLC borrowed A's physical time rather than trusting its own lagging wall clock.
        assertThat(fromB.physical()).isEqualTo(fromA.physical());
    }

    @Test
    void whenLocalAndRemoteAgreeOnThePhysicalInstant_theLogicalCountersMergeByMaximum() {
        AtomicLong fakeWallClock = new AtomicLong(1_000);
        var clock = new HybridLogicalClock("replica-b", fakeWallClock::get);
        clock.now(); // establishes local l=1000, c=0 — both sides now share the same physical instant
        var remote = new HlcTimestamp(1_000, 7, "replica-a");

        var t = clock.update(remote);

        assertThat(t.physical()).isEqualTo(1_000);
        assertThat(t.logical()).isEqualTo(8); // max(local=0, remote=7) + 1
    }
}
