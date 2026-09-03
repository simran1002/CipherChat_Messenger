/**
 * Audit module — append-only record of security-relevant actions, fed by the
 * {@code audit-events} topic. Read-only for admins; nothing else depends on it.
 */
@org.springframework.modulith.ApplicationModule(displayName = "Audit log")
package com.cipherchat.audit;
