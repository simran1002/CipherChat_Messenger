# System Design

The interview-style walk-through: requirements → estimates → high-level design → the deep dives that carry the guarantees. Companion docs hold the detail: `ARCHITECTURE.md` (modules, request paths), `DATABASE_DESIGN.md`, `KAFKA_DESIGN.md`, `SCALABILITY.md`, `SECURITY.md`.

## 1. Requirements

**Functional**: accounts with 2FA; rooms with roles; text/file/location messages with replies, reactions, pins, mentions, edits, self-destruct; read/delivery receipts and unread counts; search; end-to-end encrypted DMs with attachments; presence and typing; notifications inbox; AI summaries for rooms; admin audit/analytics.

**Non-functional** — the four the product is *about*:

| Requirement | Meaning here |
|---|---|
| Provable delivery | a message the client got an ACK for exists exactly once, in order, and reaches every online member; anything sent offline is delivered later, once |
| Operator-proof privacy | DM content is unreadable to the server operator, the DB, and the network |
| Failure survival | pod loss, rolling deploys, Redis or Kafka blips lose no messages |
| Content-free observability | operators see latency, rates, queue depth, errors — never bodies |

**Envelope**: one organisation, 50–5,000 users, ≤ 10k concurrent sockets, ~200 msg/s sustained (`SCALABILITY.md`).

## 2. Estimates

- 200 msg/s × ~1 KB row ≈ 200 KB/s of Postgres writes; 10 M rows/year ≈ 10–15 GB/year with indexes. One modest RDS instance for years.
- Fan-out: 200 msg/s × average room of 30 online members ≈ 6,000 frames/s cluster-wide — trivial for Redis pub/sub and for a few JVMs.
- Sockets: 10k connections × ~50 KB (Tomcat + session + buffers) ≈ 0.5 GB heap across pods; 2 pods at 1 GiB each hold it with room.
- Kafka: 200 events/s × ~500 B — a rounding error; sized for durability not throughput.

## 3. High-level design

```
 Browser (React, E2EE client) ── HTTPS/WSS ──▶ ALB ──▶ backend pods (stateless)
                                                      │  │  │
                                    PostgreSQL ◀──────┘  │  └──────▶ Kafka ──▶ consumers (notification, audit, analytics)
                                    Redis (coordination + WS fan-out) ◀─┘
                                    S3 (attachments; presigned PUT for encrypted blobs)
```

Single service, modular inside; three managed stores with distinct roles: **Postgres = truth**, **Redis = coordination**, **Kafka = durable "afterwards"**.

## 4. Deep dive: exactly-once message persistence

At-least-once transport (client retries until ACK) + idempotent persistence = effectively-once.

1. Client attaches a UUID `clientMessageId`; retries reuse it; an IndexedDB queue holds it offline.
2. Server fast path: Redis `SET NX dedup:<id>` (10 min) — a retry within the window is answered from cache.
3. Sequence: Redis `INCR seq:<room>`, seeded once from `max(sequence_number)` in Postgres; gapless, monotonic per room.
4. Persist in one transaction with two unique indexes as the backstop: `(room, sequence)` and `client_message_id`. If Redis lied (flush, restart, race), the index refuses the second insert and the service resolves to the existing row — the ACK still reports `duplicate: true`.
5. Outbox row in the same transaction; fan-out and Kafka publication happen strictly after commit.

Result: the DB alone guarantees uniqueness and ordering; Redis only makes the common case fast.

## 5. Deep dive: real-time fan-out across replicas

A WebSocket lives on one pod. Every pod subscribes to Redis channels `ws:room:*`, `ws:dm:*`, `ws:user:*`, `ws:all`; after commit the producing pod publishes `{event, payload}`; every pod forwards to its local STOMP subscribers. No sticky sessions, no inter-pod discovery, ordering preserved per room. Pub/sub is lossy by design — if a pod misses frames during a Redis blip, the client resynchronises from Postgres by sequence on reconnect. Durability never depends on the live channel.

## 6. Deep dive: E2EE that the server can still police

Client: X3DH-lite session setup, per-direction HMAC chains, per-counter HKDF keys, AES-256-GCM with AAD binding `{conversation, sender, session, ctr}`, padded plaintext, session rotation. Server: (a) key directory that **verifies the prekey signature** so it cannot serve mixed bundles, (b) **structural envelope validation** with hard size caps, (c) **replay backstop** — `UNIQUE (conversation, sender, sessionId, ctr)` — so a counter is spent once cluster-wide even with a hostile client, (d) content-free previews/notifications. Metadata (who/when/size) is visible; content, names and MIME types of attachments are not. Rooms remain server-readable on purpose (AI features, search) and are labelled as such.

## 7. Deep dive: the "afterwards" pipeline

Everything that must happen but must not be on the send path rides Kafka via the transactional outbox: event row committed with the message → published after commit → consumer groups (`notifications`, `audit`, `analytics`) each with their own offset. Consumers are idempotent via `processed_events(consumer, event_id)` inside the side effect's transaction; retries back off exponentially then dead-letter without blocking the partition. A consumer can be replayed from offset 0 safely.

## 8. Deep dive: authentication & sessions

15-minute HS256 access tokens; 30-day rotating refresh tokens stored as hashes, consumed atomically (replay → 401 + audit); per-device session list; password change revokes other devices; TOTP 2FA with sealed seeds and hashed backup codes, mediated by a scoped pending token that no API path accepts. WebSocket authenticates on the STOMP `CONNECT` frame, never in the URL.

## 9. Failure modes

| Failure | Effect | Recovery |
|---|---|---|
| Backend pod dies | its sockets drop | clients reconnect to another pod (LB), drain offline queue idempotently; presence self-heals in ≤ 90 s |
| Redis down | rate limiting fails open; sends still persist (sequence path fails closed → 503 for sends until Redis returns); live fan-out pauses | clients resync by sequence on reconnect; no data loss |
| Kafka down | sends unaffected; publications queue in the outbox table | republished automatically when the broker returns |
| Postgres down | sends fail with 503; nothing else pretends to work | readiness fails → pod pulled from LB; RDS Multi-AZ failover |
| Poison event | one consumer group retries 4× then dead-letters | inspect DLT, fix, replay (ledger makes replay safe) |
| Rolling deploy | zero-downtime: surge pod ready before old pod drains | `maxUnavailable: 0`, graceful shutdown > in-flight |

## 10. What I would do next at 10× scale

Read replicas for history/search; sender-keys for large-room E2EE if rooms ever needed it; move hot presence to a dedicated Redis; partition `messages` by month; Kafka partitions 12 → 48 with a topic migration; multi-device E2EE identities. None of these are needed inside the stated envelope, and all are compatible with the current schema and module layout.
