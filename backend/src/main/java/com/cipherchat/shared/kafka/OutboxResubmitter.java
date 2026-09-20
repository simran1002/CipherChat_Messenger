package com.cipherchat.shared.kafka;

import java.time.Duration;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.modulith.events.IncompleteEventPublications;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Keeps the transactional outbox honest while the application is RUNNING.
 *
 * <p>An event that could not be handed to Kafka — the broker was unreachable for longer than the producer's
 * {@code delivery.timeout.ms} — stays in {@code event_publication} as incomplete. Spring Modulith only replays
 * those at application START ({@code republish-outstanding-events-on-restart}), so after a long broker outage
 * the backlog of notification, audit and analytics events would sit undelivered until every pod happened to be
 * restarted. This resubmits them on a timer instead, which is what "publications queue in Postgres and replay"
 * has to mean for the guarantee to hold without an operator.
 *
 * <p>Only publications older than {@code resubmit-after} are touched: it must exceed the producer's delivery
 * timeout, or a publication whose send is merely still in flight would be sent a second time.
 *
 * <p>Every replica runs this, so a Postgres advisory lock elects one per tick; the rest skip. That is an
 * optimisation, not a correctness requirement — delivery is at-least-once by design and the consumers are
 * idempotent (a {@code processed_events} ledger claims each event id in the same transaction as its effect).
 */
@Component
@ConditionalOnProperty(name = "cipherchat.outbox.resubmit-enabled", havingValue = "true", matchIfMissing = true)
public class OutboxResubmitter {

    private static final Logger log = LoggerFactory.getLogger(OutboxResubmitter.class);
    /** Arbitrary, stable key for the advisory lock ("outbox" as bytes). */
    static final long LEADER_LOCK = 0x6F7574626F78L;

    private final IncompleteEventPublications incomplete;
    private final JdbcClient jdbc;
    private final TransactionTemplate tx;
    private final Duration resubmitAfter;

    public OutboxResubmitter(IncompleteEventPublications incomplete, JdbcClient jdbc, PlatformTransactionManager txManager,
                             @Value("${cipherchat.outbox.resubmit-after:PT75S}") Duration resubmitAfter) {
        this.incomplete = incomplete;
        this.jdbc = jdbc;
        this.tx = new TransactionTemplate(txManager);
        this.resubmitAfter = resubmitAfter;
    }

    @Scheduled(fixedDelayString = "${cipherchat.outbox.resubmit-interval:PT15S}", initialDelayString = "PT60S")
    public void resubmit() {
        try {
            tx.executeWithoutResult(status -> {
                // Transaction-scoped: released automatically at commit, so a crashed pod can never strand the lock.
                Boolean leader = jdbc.sql("select pg_try_advisory_xact_lock(:key)").param("key", LEADER_LOCK).query(Boolean.class).single();
                if (Boolean.TRUE.equals(leader)) {
                    incomplete.resubmitIncompletePublicationsOlderThan(resubmitAfter);
                }
            });
        } catch (RuntimeException e) {
            // A failed tick must not kill the scheduler thread's next run.
            log.warn("Outbox resubmission tick failed; will retry next interval cause={}", e.toString());
        }
    }
}
