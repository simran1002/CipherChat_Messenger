package com.cipherchat.shared.events;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import com.cipherchat.shared.events.AuditEvents.Audited;

/**
 * Publishes audit events with the right transactional coupling.
 *
 * <ul>
 *   <li>{@link #publish}: joins the caller's transaction — the audit row exists
 *       iff the action committed (a rolled-back password change leaves no
 *       "password changed" trace).</li>
 *   <li>{@link #publishDetached}: its own transaction — for actions that END
 *       in an exception (failed login), where the caller's transaction is
 *       about to roll back and would otherwise take the audit event with it.</li>
 * </ul>
 */
@Component
public class AuditPublisher {

    private final ApplicationEventPublisher events;

    public AuditPublisher(ApplicationEventPublisher events) {
        this.events = events;
    }

    @Transactional(propagation = Propagation.REQUIRED)
    public void publish(Audited event) {
        events.publishEvent(event);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void publishDetached(Audited event) {
        events.publishEvent(event);
    }
}
