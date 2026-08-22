# ADR-0002: Coordination state in Redis, behind swappable interfaces

**Status:** Accepted (Phase 2)

## Problem
Every reliability mechanism lived in per-process memory: the message
deduplicator, per-room sequence counters, rate-limit buckets, the online-user
roster, and Socket.IO's room fan-out. With two replicas, each pod had a
different, wrong view: retries landing on the other pod double-persisted,
both pods issued sequence 1,2,3… for the same room, users got 2× the rate
budget, and a DM notification targeted at a raw `socketId` was silently
dropped whenever sender and recipient landed on different pods.

## Requirement
N backend replicas must behave as one logical server: exactly-once
persistence, monotonic per-room sequences, one shared rate budget, one
roster, and cross-pod broadcast — while local dev and unit tests stay
dependency-free.

## Decision
Each mechanism is an interface (`IDeduplicator`, `ISequenceCounter`,
`IRateLimiter`, `IPresenceRegistry`) with two implementations, selected once
at boot by `REDIS_URL` (`src/shared/index.ts`):

| Concern | Redis primitive |
|---|---|
| Dedup | `SET dedup:{clientId} {serverId} NX EX 600` (atomic first-writer-wins) |
| Sequences | `INCR seq:{room}`, seeded from Mongo max via `SET NX` (restart-safe) |
| Rate limit | Lua token bucket (single atomic script — no read-modify-write race) |
| Presence | Hash + index set with TTL (dead-pod safety net; `list()` prunes) |
| Fan-out | `@socket.io/redis-adapter`; per-user rooms `user:{id}` replace socketId targeting |

Deliberately NOT in Redis: typing-indicator TTL timers and heartbeat
miss-counters (socket-affine under sticky sessions — the expiry broadcast
travels through the adapter anyway), and per-process Prometheus counters
(aggregation is the scraper's job).

## Trade-off
- Two implementations to maintain per concern; the interfaces keep them
  honest and the Redis suite runs against a real Redis in CI.
- Redis becomes a hard dependency for multi-replica deployments (single
  point of coordination). Acceptable at the target scale (≤4 pods, one org);
  Redis Cluster/Sentinel is the documented growth path.
- DB-level unique indexes (`clientMessageId`, `{chatroom, sequenceNumber}`)
  back the Redis layer so a coordination failure degrades to a rejected
  write, never a duplicate message.
