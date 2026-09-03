# Why This System Is Different

## The problem

Small organizations that handle sensitive conversations — legal clinics,
healthcare practices, journalism and NGO teams — cannot put those
conversations in a third-party SaaS. Vendor breach, vendor subpoena, vendor
employee: every one of them reads the org's most private communication.
Self-hosting solves *custody* but not *trust in your own operator*, and
self-hosted deployments are exactly where nodes die, disks fill, and nobody
is on call.

CipherChat is a self-hostable team messenger built around the four
requirements that actually follow from "self-hosted + sensitive":

| Requirement | What this system does about it |
|---|---|
| **Provable delivery** | At-least-once transport with exactly-once persistence: client-UUID dedup, per-room sequence numbers, ACK/retry with backoff, offline IndexedDB queue — and the guarantee itself lives in PostgreSQL unique indexes, so a wrong counter or a missed dedup *cannot be persisted*. Demonstrated by killing a pod mid-conversation. |
| **Operator-proof privacy** | E2EE DMs (X3DH-lite + per-direction HMAC chains + AES-256-GCM), self-implemented and pinned to RFC/NIST test vectors, with safety numbers, recovery codes, and an honest threat model. The server verifies prekey signatures and enforces a replay index — the only cryptographic duties it has. Even the DB admin reads only ciphertext. |
| **Failure survival** | Stateless replicas behind a `least_conn` balancer (no sticky sessions), Redis coordination, a transactional outbox so Kafka being down never fails a send, idempotent consumers with dead-lettering, graceful drain on deploy — a rolling deploy or a killed pod loses zero messages. |
| **Content-free observability** | Operators get p50/p95/p99 send latency, delivery rates, concurrency and consumer lag (Prometheus + in-app dashboard) without any metric or log line that could reveal message content. |

## What it deliberately is NOT

- **Not a Slack clone with encryption sprinkled on.** The split is explicit
  and architectural: DMs are E2EE (no server AI, by construction); rooms are
  server-readable team spaces (AI summaries, server-side search, TTL
  self-destruct). Two privacy tiers, honestly labeled — see ADR-0004.
- **Not a demo of technologies.** Every component traces
  problem → requirement → decision → trade-off in `docs/adr/`. Kafka exists
  because notifications, audit and analytics must survive a crash and be
  replayable without touching the send path — not because it looks good on a
  README. Redis exists because rate limits, sequences and presence must hold
  across replicas.
- **Not microservices.** One organisation, ~200 msg/s: a modular monolith
  whose module boundaries fail the build when violated is the honest fit;
  the events between modules are the same records that go to Kafka, so a
  module can leave later without redesign (ADR-0010).
- **Not "webscale."** The scale assumptions below are defensible for the
  target customer, and the parts that would change at 10–100× are named.

## Scale assumptions (and what they drove)

Single-org deployments:

| Assumption | Value | What it drove |
|---|---|---|
| Users per org | 50 – 5,000 | Membership as a join table with roles; unread counts as indexed range-counts against a per-(user, room) watermark |
| Concurrent sockets | up to 10,000 org-wide; ~2,000 comfortable per pod | Stateless pods, `least_conn` LB, Redis pub/sub fan-out, bounded + throttled roster broadcasts, HPA on CPU or open sessions |
| Peak message rate | ~200 msg/s org-wide, 1,000 bursts | Lua token bucket (20 burst / 2 s refill per user); one transaction per send; virtual threads so the pool, not the thread count, is the knob |
| History growth | ~10 M messages/yr, tens of GB | Cursor pagination on `sequence_number` / `id`; GIN full-text index; attachments in object storage, never in the database |
| Redis working set | < 1 GB | Single primary with failover; nothing in Redis is a source of truth |
| Event volume | ~200 events/s | 6–12 partitions keyed by conversation; sized for durability (RF 3), not throughput |

**What changes at 10× (and is deliberately out of scope):** read replicas
for history/search, more Kafka partitions (a topic migration), a dedicated
presence Redis, monthly partitioning of `messages`, multi-device E2EE
identities. Each is listed in `SYSTEM_DESIGN.md` §10 with the trigger that
would justify it.

## Measured — on the previous implementation

The numbers below were measured on the Node/Socket.IO implementation this
system replaced, on one Windows laptop with everything co-located. They are
kept because they are real, and labelled because they are not yet re-run
against the Java backend (the harness targets Socket.IO and needs a STOMP
client; see `INTERVIEW-REVIEW.md`).

| Measurement | Result |
|---|---|
| Connection density, one pod (`scripts/connflood.mts`) | **10,000 / 10,000 held, zero failures**, 470 MB RSS (~47 KB/socket); message probe through the held load ACKed 200/200 at p50 43 ms / p95 95 ms |
| k6, 50 VUs across 10 rooms via the LB | ACK p95 **176 ms** (p50 19 ms), 100 % checks |
| k6, 50 VUs in one hot room (50× fan-out) | p95 2.55 s — fan-out, not message rate, is the cost driver |
| Failover, socket-owning pod killed mid-stream | 60/60 exactly once, gap-free sequences, gap ≈ 2.4 s |

The design carried forward the fixes those runs forced (bounded/throttled
roster broadcasts, seeded sequence counters, idempotent retries) and replaced
the one component that made the hot-room ceiling what it was — a single
event loop doing every socket write — with virtual-thread request handling
and per-pod STOMP brokers fed by Redis. Re-measuring is the next step, and
the claim until then is the design, not the number.

## The engineering signals an interviewer can check

1. The guarantees are constraints: `\d messages` and `\d dm_messages` show
   the unique indexes; `MessagingIT` double-sends and asserts one row;
   `DirectMessageIT` replays a counter and asserts `409`.
2. A crypto implementation pinned to RFC 7748 / 8032 / 5869 / NIST GCM
   vectors (client) and RFC 6238 (server TOTP), with tamper, replay,
   out-of-order and rotation tests.
3. The transactional outbox and idempotent consumers, exercised through a
   real broker in `KafkaConsumersIT`.
4. A module boundary test (`ModularityTests`) that turns the architecture
   diagram into a red or green build.
5. ADRs where every major choice names the alternative it rejected and the
   cost it accepted — including ADR-0010, the decision to replace the stack.
