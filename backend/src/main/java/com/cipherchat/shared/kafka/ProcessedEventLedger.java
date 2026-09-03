package com.cipherchat.shared.kafka;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Idempotency ledger for Kafka consumers. Kafka delivers at-least-once; a
 * consumer that crashes between "side effect committed" and "offset
 * committed" sees the record again. Consumers call {@link #claim} inside the
 * SAME transaction as their side effect: if the insert loses (already
 * processed), they skip; if the transaction rolls back, the claim rolls back
 * with it and the retry proceeds normally.
 *
 * <p>{@link Propagation#MANDATORY} makes a missing transaction a loud failure
 * rather than a silent duplicate.
 */
@Component
public class ProcessedEventLedger {

    private static final Logger log = LoggerFactory.getLogger(ProcessedEventLedger.class);
    private static final Duration RETENTION = Duration.ofDays(7);

    private final JdbcClient jdbc;

    public ProcessedEventLedger(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** @return true if this consumer has NOT processed the event before (and now owns it). */
    @Transactional(propagation = Propagation.MANDATORY)
    public boolean claim(String consumer, UUID eventId) {
        int inserted = jdbc.sql("insert into processed_events (consumer, event_id) values (:c, :e) on conflict do nothing")
                .param("c", consumer).param("e", eventId).update();
        if (inserted == 0) log.debug("Duplicate delivery skipped consumer={} eventId={}", consumer, eventId);
        return inserted == 1;
    }

    /** Kafka retention bounds how old a redelivery can be; keep the ledger a little longer than that. */
    @Scheduled(fixedDelayString = "PT1H", initialDelayString = "PT10M")
    @Transactional
    public void sweep() {
        int n = jdbc.sql("delete from processed_events where processed_at < :cutoff")
                .param("cutoff", Instant.now().minus(RETENTION)).update();
        if (n > 0) log.info("Swept {} processed_events older than {}", n, RETENTION);
    }
}
