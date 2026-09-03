package com.cipherchat.audit;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.kafka.annotation.KafkaHandler;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.cipherchat.shared.events.AuditEvents.Audited;
import com.cipherchat.shared.kafka.ProcessedEventLedger;

import io.swagger.v3.oas.annotations.tags.Tag;

/** Consumer group {@code audit}: one row per event, idempotent via the ledger. */
@Component
@KafkaListener(id = "audit", groupId = "audit", topics = "${cipherchat.kafka.topics.audit-events}")
public class AuditConsumer {

    static final String CONSUMER = "audit";

    interface AuditRepository extends JpaRepository<AuditLog, Long> {
        List<AuditLog> findAllByOrderByCreatedAtDesc(Limit limit);
        List<AuditLog> findByActorIdOrderByCreatedAtDesc(UUID actorId, Limit limit);
    }

    private final AuditRepository logs;
    private final ProcessedEventLedger ledger;

    public AuditConsumer(AuditRepository logs, ProcessedEventLedger ledger) {
        this.logs = logs;
        this.ledger = ledger;
    }

    @KafkaHandler
    @Transactional
    public void on(Audited e) {
        if (!ledger.claim(CONSUMER, e.eventId())) return;
        logs.save(AuditLog.from(e));
    }

    @KafkaHandler(isDefault = true)
    public void ignore(Object other) {
    }

    /** Admin read side; the path is ADMIN-only in SecurityConfig. */
    @RestController
    @RequestMapping("/api/v1/admin/audit")
    @Tag(name = "Admin · Audit", description = "Security audit trail")
    static class AuditController {

        public record View(String id, String actorId, String action, String targetType, String targetId,
                           Map<String, Object> metadata, String ip, Instant createdAt) {
            static View of(AuditLog a) {
                return new View(String.valueOf(a.getId()), a.getActorId() == null ? null : a.getActorId().toString(),
                        a.getAction(), a.getTargetType(), a.getTargetId(), a.getMetadata(), a.getIp(), a.getCreatedAt());
            }
        }

        private final AuditRepository logs;

        AuditController(AuditRepository logs) {
            this.logs = logs;
        }

        @GetMapping
        @Transactional(readOnly = true)
        public List<View> list(@RequestParam(required = false) UUID actorId, @RequestParam(defaultValue = "100") int limit) {
            Limit l = Limit.of(Math.min(Math.max(limit, 1), 500));
            List<AuditLog> rows = actorId == null ? logs.findAllByOrderByCreatedAtDesc(l) : logs.findByActorIdOrderByCreatedAtDesc(actorId, l);
            return rows.stream().map(View::of).toList();
        }
    }
}
