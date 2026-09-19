package com.cipherchat.presence.crdt;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.atomic.AtomicLong;

import org.junit.jupiter.api.Test;

class LwwRegisterTest {

    private static HlcTimestamp ts(long physical, long logical, String replica) {
        return new HlcTimestamp(physical, logical, replica);
    }

    @Test
    void mergeKeepsTheLaterTimestampsValue() {
        var older = LwwRegister.initial("away", ts(100, 0, "a"));
        var newer = older.set("online", ts(200, 0, "b"));
        assertThat(older.merge(newer).value()).isEqualTo("online");
        assertThat(newer.merge(older).value()).isEqualTo("online"); // commutative
    }

    @Test
    void mergeIsCommutativeAssociativeAndIdempotent() {
        var a = LwwRegister.initial("a-wrote-this", ts(100, 0, "a"));
        var b = LwwRegister.initial("b-wrote-this", ts(150, 0, "b"));
        var c = LwwRegister.initial("c-wrote-this", ts(120, 0, "c"));

        assertThat(a.merge(b).value()).isEqualTo(b.merge(a).value());
        assertThat(a.merge(b).merge(c).value()).isEqualTo(a.merge(b.merge(c)).value());
        assertThat(a.merge(a).value()).isEqualTo(a.value());
    }

    /**
     * The property a naive wall-clock LWW register does NOT have. Region A's clock is far ahead; region
     * B's is behind. B updates status only AFTER receiving A's message, so B's write is causally later —
     * and because B's HLC folded A's timestamp in via {@link HybridLogicalClock#update}, B's write
     * correctly outranks A's even though a raw wall-clock comparison would have said otherwise.
     */
    @Test
    void aCausallyLaterWriteWinsEvenFromAClockThatReadsEarlier() {
        AtomicLong clockOnA = new AtomicLong(10_000);
        AtomicLong clockOnB = new AtomicLong(1_000); // skewed behind A
        var hlcA = new HybridLogicalClock("region-a", clockOnA::get);
        var hlcB = new HybridLogicalClock("region-b", clockOnB::get);

        var register = LwwRegister.initial("available", hlcA.now());
        HlcTimestamp aWroteAway = hlcA.now();
        register = register.set("away", aWroteAway);

        // B receives A's "away" update, and in response (a moment later, on B's own lagging clock)
        // writes "online" — this genuinely happened after A's write in real time.
        HlcTimestamp bClockAfterReceivingA = hlcB.update(aWroteAway);
        var bsRegister = LwwRegister.initial("online", bClockAfterReceivingA);

        var merged = register.merge(bsRegister);
        assertThat(merged.value()).isEqualTo("online");
    }

    @Test
    void twoIndependentRegionsWritingConcurrently_convergeToTheSameWinnerRegardlessOfMergeOrder() {
        var fromRegionA = LwwRegister.initial("busy", ts(500, 0, "region-a"));
        var fromRegionB = LwwRegister.initial("in a meeting", ts(500, 3, "region-b")); // same instant, higher logical

        assertThat(fromRegionA.merge(fromRegionB).value()).isEqualTo("in a meeting");
        assertThat(fromRegionB.merge(fromRegionA).value()).isEqualTo("in a meeting");
    }
}
