package com.cipherchat.presence.crdt;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class GCounterTest {

    @Test
    void sumsEachReplicasOwnContributions() {
        var counter = GCounter.empty().increment("a", 3).increment("b", 5).increment("a", 2);
        assertThat(counter.value()).isEqualTo(10); // a: 3+2=5, b: 5
    }

    @Test
    void rejectsANegativeIncrement_itIsGrowOnlyByConstruction() {
        assertThatThrownBy(() -> GCounter.empty().increment("a", -1)).isInstanceOf(IllegalArgumentException.class);
    }

    // The three join-semilattice laws — asserted directly, not assumed, because they are the entire
    // reason this converges regardless of network delivery order, duplication or partial partition.

    @Test
    void mergeIsCommutative() {
        var a = GCounter.empty().increment("a", 3).increment("b", 1);
        var b = GCounter.empty().increment("b", 5).increment("c", 2);
        assertThat(a.merge(b).value()).isEqualTo(b.merge(a).value());
    }

    @Test
    void mergeIsAssociative() {
        var a = GCounter.empty().increment("a", 3);
        var b = GCounter.empty().increment("b", 5);
        var c = GCounter.empty().increment("c", 7);
        assertThat(a.merge(b).merge(c).value()).isEqualTo(a.merge(b.merge(c)).value());
    }

    @Test
    void mergeIsIdempotent_applyingTheSameUpdateTwiceChangesNothing() {
        var a = GCounter.empty().increment("a", 3).increment("b", 5);
        assertThat(a.merge(a).value()).isEqualTo(a.value());
    }

    @Test
    void convergesToTheSameValueRegardlessOfMergeOrder_theWholePointOfTheExercise() {
        var regionA = GCounter.empty().increment("region-a", 4);
        var regionB = GCounter.empty().increment("region-b", 6);
        var regionC = GCounter.empty().increment("region-c", 1);

        long viaAThenBThenC = regionA.merge(regionB).merge(regionC).value();
        long viaCThenAThenB = regionC.merge(regionA).merge(regionB).value();
        long viaBThenCThenA = regionB.merge(regionC).merge(regionA).value();

        assertThat(viaAThenBThenC).isEqualTo(11).isEqualTo(viaCThenAThenB).isEqualTo(viaBThenCThenA);
    }
}
