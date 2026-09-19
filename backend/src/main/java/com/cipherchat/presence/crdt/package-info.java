/**
 * Conflict-free replicated data types for ephemeral, high-frequency state (presence, session counts,
 * status) — the merge algorithms a multi-region deployment would need, proven correct here as a
 * standalone library. Internal to the {@code presence} module: nothing outside it depends on this
 * package, and nothing here is wired into {@link com.cipherchat.presence.PresenceRegistry} or
 * {@link com.cipherchat.presence.PresenceService}, which run correctly today against one Redis instance
 * with no merge problem to solve. See ADR-0015 for exactly what this is, and — just as importantly —
 * what it deliberately is not.
 */
package com.cipherchat.presence.crdt;
