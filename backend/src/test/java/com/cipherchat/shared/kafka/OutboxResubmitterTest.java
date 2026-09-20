package com.cipherchat.shared.kafka;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.RETURNS_DEEP_STUBS;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Duration;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.modulith.events.IncompleteEventPublications;
import org.springframework.transaction.PlatformTransactionManager;

class OutboxResubmitterTest {

    private static final Duration AFTER = Duration.ofSeconds(75);

    private final IncompleteEventPublications incomplete = mock(IncompleteEventPublications.class);
    private final JdbcClient jdbc = mock(JdbcClient.class, RETURNS_DEEP_STUBS);
    private final PlatformTransactionManager tx = mock(PlatformTransactionManager.class);

    private OutboxResubmitter resubmitter() {
        return new OutboxResubmitter(incomplete, jdbc, tx, AFTER);
    }

    private void electedLeader(boolean leader) {
        when(jdbc.sql(any(String.class)).param(any(String.class), any()).query(Boolean.class).single()).thenReturn(leader);
    }

    @Test
    void theElectedReplicaResubmitsPublicationsOlderThanTheDeliveryTimeout() {
        electedLeader(true);

        resubmitter().resubmit();

        verify(incomplete).resubmitIncompletePublicationsOlderThan(AFTER);
    }

    @Test
    void aReplicaThatLostTheElectionDoesNotResubmit_soNoTwoPodsSendTheSameBacklog() {
        electedLeader(false);

        resubmitter().resubmit();

        verify(incomplete, never()).resubmitIncompletePublicationsOlderThan(any());
    }

    @Test
    void aFailingTickIsSwallowed_theNextScheduledRunStillHappens() {
        electedLeader(true);
        org.mockito.Mockito.doThrow(new IllegalStateException("broker still down")).when(incomplete).resubmitIncompletePublicationsOlderThan(any());

        resubmitter().resubmit(); // must not propagate: an exception would cancel further runs of the scheduled task
    }
}
