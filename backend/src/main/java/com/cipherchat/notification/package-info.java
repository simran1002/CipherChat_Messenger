/**
 * Notification module — durable, per-user notification inbox fed by Kafka.
 * Real-time toasts are the gateway's job; this module guarantees the user
 * still sees the @mention or DM that arrived while they were offline.
 */
@org.springframework.modulith.ApplicationModule(displayName = "Notifications")
package com.cipherchat.notification;
