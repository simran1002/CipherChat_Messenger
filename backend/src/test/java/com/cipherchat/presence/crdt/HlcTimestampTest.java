package com.cipherchat.presence.crdt;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class HlcTimestampTest {

    @Test
    void ordersByPhysicalTimeFirst() {
        var earlier = new HlcTimestamp(100, 99, "z-replica");
        var later = new HlcTimestamp(101, 0, "a-replica");
        assertThat(earlier).isLessThan(later);
    }

    @Test
    void logicalCounterBreaksTiesOnEqualPhysicalTime() {
        var a = new HlcTimestamp(100, 1, "replica");
        var b = new HlcTimestamp(100, 2, "replica");
        assertThat(a).isLessThan(b);
    }

    @Test
    void replicaIdIsTheLastResortTiebreak() {
        var a = new HlcTimestamp(100, 5, "alice");
        var b = new HlcTimestamp(100, 5, "bob");
        assertThat(a).isLessThan(b);
        assertThat(b.compareTo(a)).isGreaterThan(0);
    }

    @Test
    void happensBeforeOrEqualsMatchesTheTotalOrder() {
        var a = new HlcTimestamp(100, 0, "a");
        var b = new HlcTimestamp(100, 1, "a");
        assertThat(a.happensBeforeOrEquals(b)).isTrue();
        assertThat(b.happensBeforeOrEquals(a)).isFalse();
        assertThat(a.happensBeforeOrEquals(a)).isTrue();
    }
}
