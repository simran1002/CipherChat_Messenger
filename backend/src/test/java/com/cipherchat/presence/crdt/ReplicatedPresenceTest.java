package com.cipherchat.presence.crdt;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import org.junit.jupiter.api.Test;

import com.cipherchat.presence.crdt.ReplicatedPresence.StatusNote;
import com.cipherchat.user.PresenceStatus;

class ReplicatedPresenceTest {

    private static final UUID ALICE = UUID.randomUUID();

    @Test
    void aFreshConnectIsOnlineWithOneSession() {
        var hlc = new HybridLogicalClock("region-a");
        var presence = ReplicatedPresence.firstConnect(ALICE, "region-a", hlc.now(), new StatusNote(PresenceStatus.AVAILABLE, ""));

        assertThat(presence.isOnline()).isTrue();
        assertThat(presence.sessionCount()).isEqualTo(1);
    }

    @Test
    void refusesToMergePresenceOfDifferentUsers() {
        var hlc = new HybridLogicalClock("region-a");
        var alice = ReplicatedPresence.firstConnect(ALICE, "region-a", hlc.now(), new StatusNote(PresenceStatus.AVAILABLE, ""));
        var bob = ReplicatedPresence.firstConnect(UUID.randomUUID(), "region-a", hlc.now(), new StatusNote(PresenceStatus.AVAILABLE, ""));

        assertThatThrownBy(() -> alice.merge(bob)).isInstanceOf(IllegalArgumentException.class);
    }

    /**
     * The end-to-end scenario the whole exercise is for: two regions, network-partitioned, each handling
     * real events for the same user with no coordination, then reconciling. This is deliberately NOT run
     * against real cross-region infrastructure (there isn't any here to run it against) — it proves the
     * merge algorithm converges correctly in isolation, which is the piece this repository can actually
     * verify. See ADR-0015 for what would still be needed to deploy this for real.
     */
    @Test
    void twoPartitionedRegionsConcurrentlyHandleTheSameUserAndConvergeOnMergeRegardlessOfOrder() {
        AtomicLong wallClockA = new AtomicLong(1_000);
        AtomicLong wallClockB = new AtomicLong(1_000); // same instant — a genuinely concurrent write on each side
        var hlcA = new HybridLogicalClock("region-a", wallClockA::get);
        var hlcB = new HybridLogicalClock("region-b", wallClockB::get);

        // Region A: Alice's laptop connects.
        var onRegionA = ReplicatedPresence.firstConnect(ALICE, "region-a", hlcA.now(), new StatusNote(PresenceStatus.AVAILABLE, ""));
        // Region B, concurrently and independently: Alice's phone ALSO connects, and she sets herself busy.
        var onRegionB = ReplicatedPresence.firstConnect(ALICE, "region-b", hlcB.now(), new StatusNote(PresenceStatus.AVAILABLE, ""))
                .updateStatus(new StatusNote(PresenceStatus.BUSY, "in a call"), hlcB.now());

        var mergedAFirst = onRegionA.merge(onRegionB);
        var mergedBFirst = onRegionB.merge(onRegionA);

        assertThat(mergedAFirst).isEqualTo(mergedBFirst);
        assertThat(mergedAFirst.sessionCount()).isEqualTo(2); // one live session per region
        assertThat(mergedAFirst.status()).isEqualTo(new StatusNote(PresenceStatus.BUSY, "in a call"));
        assertThat(mergedAFirst.isOnline()).isTrue();

        // Alice closes her laptop (region A) after the merge already happened elsewhere; the disconnect
        // still applies cleanly against the merged state and a re-merge changes nothing (idempotent).
        var afterLaptopCloses = mergedAFirst.disconnect("region-a");
        assertThat(afterLaptopCloses.sessionCount()).isEqualTo(1);
        assertThat(afterLaptopCloses.isOnline()).isTrue();
        assertThat(afterLaptopCloses.merge(mergedBFirst).sessionCount()).isEqualTo(1);
    }

    @Test
    void goingFullyOfflineIsWhatDropsTheSessionCountToZero() {
        var hlc = new HybridLogicalClock("region-a");
        var presence = ReplicatedPresence.firstConnect(ALICE, "region-a", hlc.now(), new StatusNote(PresenceStatus.AVAILABLE, ""))
                .disconnect("region-a");

        assertThat(presence.isOnline()).isFalse();
        assertThat(presence.sessionCount()).isZero();
    }
}
