package com.cipherchat.dm;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.UUID;

import org.junit.jupiter.api.Test;

/**
 * The (user_low, user_high) pair must be ordered the way PostgreSQL orders UUIDs (unsigned
 * bytes), because the CHECK constraint is evaluated there. Java's UUID.compareTo is signed and
 * disagrees for pairs like these — the bug this test pins was found by DirectMessageIT.
 */
class ConversationOrderingTest {

    private static final UUID HIGH_BIT_SET = UUID.fromString("80000000-0000-0000-0000-000000000000");
    private static final UUID HIGH_BIT_CLEAR = UUID.fromString("7fffffff-ffff-ffff-ffff-ffffffffffff");

    @Test
    void javaSignedOrderDisagreesWithPostgresForThisPair() {
        // Sanity: the pair really is one where the two orders differ.
        assertThat(HIGH_BIT_SET.compareTo(HIGH_BIT_CLEAR)).isNegative();          // signed: 0x80… < 0x7f…
        assertThat(Conversation.compareUnsigned(HIGH_BIT_SET, HIGH_BIT_CLEAR)).isPositive();   // unsigned: 0x80… > 0x7f…
    }

    @Test
    void betweenUsesUnsignedOrder_andIsSymmetric() {
        Conversation ab = Conversation.between(HIGH_BIT_SET, HIGH_BIT_CLEAR);
        Conversation ba = Conversation.between(HIGH_BIT_CLEAR, HIGH_BIT_SET);
        assertThat(ab.getUserLow()).isEqualTo(HIGH_BIT_CLEAR);
        assertThat(ab.getUserHigh()).isEqualTo(HIGH_BIT_SET);
        assertThat(ba.getUserLow()).isEqualTo(ab.getUserLow());
        assertThat(ba.getUserHigh()).isEqualTo(ab.getUserHigh());
    }

    @Test
    void randomPairsAlwaysSatisfyLowLessThanHighInUnsignedOrder() {
        for (int i = 0; i < 10_000; i++) {
            UUID a = UUID.randomUUID();
            UUID b = UUID.randomUUID();
            Conversation c = Conversation.between(a, b);
            assertThat(Conversation.compareUnsigned(c.getUserLow(), c.getUserHigh())).isNegative();
            assertThat(c.has(a)).isTrue();
            assertThat(c.has(b)).isTrue();
        }
    }
}
