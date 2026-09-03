/**
 * Presence module — who is online (Redis, TTL-backed so a dead pod's users
 * expire instead of ghosting), heartbeats, the bounded roster, typing
 * indicators, and the {@code UserOnline/UserOffline} events.
 */
@org.springframework.modulith.ApplicationModule(displayName = "Presence", allowedDependencies = "user")
package com.cipherchat.presence;
