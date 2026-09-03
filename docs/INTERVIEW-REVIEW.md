# Interview Review — questions to expect, wow factors, weak points

A self-administered SDE-3 interview pass over this repository: the questions
a strong interviewer is likely to ask, the concept each one is really
probing, and an honest account of what impresses vs. what can be attacked.
The system under review is the Java / Spring Boot modular monolith in
`backend/` (ADR-0010); an appendix keeps the history of the previous Node
implementation because several of its lessons still apply.

---

## Questions an interviewer is likely to ask

### Architecture & scalability
| Question | Concept to explain (and where it lives) |
|---|---|
| "Walk me through what happens when I hit Send." | rate limit → Redis dedup → seeded per-room `INCR` → one transaction (message + watermark + outbox row) with two unique indexes as the backstop → ACK; after commit: Redis fan-out to every replica, Kafka for the durable afterwards (`ARCHITECTURE.md` § request paths, `MessageService.sendDraft`) |
| "Why a modular monolith and not microservices?" | One org per deployment, ~200 msg/s; the hot path touches auth, membership, sequence, persistence and fan-out — hops and sagas for no scaling win. Boundaries are enforced by `ModularityTests`; modules talk through events that already go to Kafka, so extraction later is a consumer move, not a redesign (ADR-0010) |
| "Why no sticky sessions?" | STOMP over raw WebSocket, no polling fallback; the socket is pinned by TCP, everything *about* the session (presence, buckets, counters) is in Redis or Postgres; fan-out rides Redis pub/sub so any pod can hold any socket (`SCALABILITY.md`) |
| "Why Postgres and not Mongo this time?" | The guarantees are unique indexes: `(room, sequence)`, `client_message_id`, `(conversation, sender, sessionId, ctr)`, `lower(email)`. Constraints are the engineering; Postgres makes them first-class and transactional with the outbox row (`DATABASE_DESIGN.md`) |
| "What breaks first as you scale?" | Postgres write path (single writer) — idle at the envelope, read replicas for history/search first; then Kafka partitions (12 → migration); then presence Redis. `SYSTEM_DESIGN.md` §10 names the order |
| "Where is Kafka the wrong tool here, and what did you use instead?" | Live fan-out to WebSocket sessions — consumer groups mean one pod would get each event; you'd need a group per pod and pay Kafka's latency floor. Redis pub/sub does "every replica sees every event"; durability is Postgres + Kafka, never pub/sub (`KAFKA_DESIGN.md`) |

### Concurrency & consistency
| Question | Concept |
|---|---|
| "Two replicas receive the same retry simultaneously." | Redis `SET NX` picks a winner; the loser finds the row and ACKs `duplicate: true`. If Redis is stale, the `client_message_id` unique index refuses the second insert and `DataIntegrityViolationException` is resolved to the existing row — in a `REQUIRES_NEW` transaction so the resolution can run after the rollback. `MessagingIT` double-sends |
| "How do you order messages across replicas?" | Per-room Redis `INCR`, seeded once from `max(sequence_number)`; the `(room, sequence)` unique index guarantees a wrong counter can't produce two messages in one slot. Global order deliberately not promised |
| "Your Kafka consumer crashed after writing the notification but before committing the offset." | Redelivery → `processed_events(consumer, event_id)` claim loses → no-op. The claim shares the side effect's transaction (`Propagation.MANDATORY` so forgetting `@Transactional` fails loudly). `KafkaConsumersIT` asserts exactly one inbox row |
| "Kafka is down. What happens to a send?" | Nothing — the publication row is committed with the message (transactional outbox) and republished when the broker returns. Readiness reports the dependency, sends keep ACKing |
| "Your rate limiter is read-modify-write — race?" | Single Lua script, atomic in Redis; shared across pods; fails **open** if Redis is unreachable (logged) |
| "Two users click 'start conversation' at once." | `(user_low, user_high)` unique with `user_low < user_high` CHECK; loser re-reads. Race handled by the index, not by a lock |

### Security & crypto
| Question | Concept |
|---|---|
| "The server can't read DMs — so what can it enforce?" | Three things, all it needs: prekey signature verification (JDK Ed25519) so the directory can't serve mixed bundles; structural envelope validation with size caps so the opaque channel isn't free storage; the `(conversation, sender, sessionId, ctr)` unique index so a counter is spent once cluster-wide (`SECURITY.md`) |
| "Why roll your own protocol instead of libsignal?" | ADR-0003's rejection table: web packaging, and a correct, testable, honestly-scoped protocol demonstrates more than an integrated black box. Primitives are audited (`@noble`), only the composition is ours, and the composition is vector-tested |
| "Where does forward secrecy actually stand?" | Session-granular (200 msgs / 7 days), not per-message. Stated plainly; upgrade path = DH ratchet as new session |
| "XSS steals the access token — then what?" | 15-minute blast radius; refresh cookie is httpOnly and rotates on use; a replayed rotated token is a 401 **and an audit event** (`user.refresh_rejected`) — the theft tripwire is now recorded, not just refused |
| "How does a failed login get audited if the transaction rolls back?" | `AuditPublisher.publishDetached` — `REQUIRES_NEW`, so the evidence commits even though the login's exception rolls the outer transaction back. Successes join the transaction so a rolled-back password change leaves no "changed" trace |
| "An ADMIN role in the DB — how does it reach the request?" | Signed into the JWT (`role` claim) from `UserView.role`; `/api/v1/admin/**` requires `ROLE_ADMIN`. (The previous implementation hardcoded the role — found and fixed during the port) |
| "Who can read room messages?" | The operator — on purpose. Two privacy tiers, honestly labeled; AI features and server search require plaintext (ADR-0004) |

### Testing, ops, performance
| Question | Concept |
|---|---|
| "How do you know the crypto is right?" | Client: RFC 7748/8032/5869 + NIST GCM vectors, golden transcript, tamper/replay/out-of-order/rotation suites. Server: TOTP against RFC 6238 vectors, SecretBox tamper test, Ed25519 verify with JDK-generated keys |
| "How do you test the socket layer without mocks lying to you?" | `StompGatewayIT`: real Spring context on a random port, real `WebSocketStompClient`, real Postgres/Redis/Kafka from Testcontainers — connect with a JWT, send, assert the ACK on the private queue and the broadcast on another user's subscription, then the duplicate ACK with no second broadcast |
| "A pod dies mid-deploy — walk me through it." | `maxUnavailable: 0` so the surge pod is ready first; preStop sleep so the LB stops routing; SIGTERM → Spring graceful shutdown drains in-flight requests (grace period > shutdown timeout); clients reconnect via `least_conn`, drain the offline queue idempotently; outbox rows on the dead pod are republished by any survivor |
| "What's your p95 and how do you know?" | `cipherchat.send.latency` timer publishes p50/p95/p99 to Prometheus and the in-app dashboard; the STOMP and HTTP ITs are the correctness floor, the k6 run against `/ws` is the next measurement to refresh (previous-implementation numbers in the appendix) |
| "Why cursor pagination?" | offset scans linearly with depth; `sequence_number` / `id` cursors are index range scans and stable under concurrent inserts |
| "How do you keep the modules honest over time?" | `ApplicationModules.verify()` runs in the unit stage: an undeclared dependency or a reach into another module's internals is a red build. `Documenter` regenerates the C4 diagrams so the architecture doc can't drift |

---

## WOW factors

1. **Guarantees enforced by the database, not by discipline** — every
   "cannot happen" maps to a unique index, a transaction boundary or a test.
   The ACK is a promise Postgres keeps.
2. **The transactional outbox, end to end** — message row and event row
   commit together; Kafka down never fails a send; consumers are idempotent
   through a ledger inside the side-effect transaction; poison records
   dead-letter without blocking. `KafkaConsumersIT` watches a mention become
   exactly one inbox row through the real broker.
3. **E2EE where the server still polices the protocol** — prekey signature
   verification, structural envelope validation, and a replay unique index,
   with a `409 replayed_counter` you can trigger in an integration test.
4. **Build-time architecture** — Spring Modulith turns the module diagram
   into a failing test.
5. **No sticky sessions, provably** — STOMP over raw WS, Redis fan-out, a
   `least_conn` LB, and a kill-a-pod demo that reconnects to the survivor.
6. **Two privacy tiers as a product decision** — E2EE DMs vs server-readable
   AI rooms, argued instead of hidden (ADR-0004).
7. **Audit that survives rollback** — detached publication for failures;
   refresh-token replay is an event, not just an error.
8. **Deployment as code, with the failure it fixes documented** — Dockerfile,
   Compose, Kubernetes (HPA/PDB/probes/IRSA), Terraform, Render blueprint,
   and a root-cause analysis of why dashboard-configured deploys kept
   failing (`DEPLOYMENT.md`).
9. **Content-free observability as a constraint** — counters, timings,
   correlation ids; DM events carry no content by construction.
10. **An honest threat model in the README** — including "a malicious client
    build served by the operator," which most web-E2EE products omit.

---

## Weak points (defend, don't hide)

**Accepted and documented:**
- **Session-granular forward secrecy** (ADR-0003); upgrade path documented.
- **Single-device E2EE** — restore-with-recovery-code or reset-with-banner;
  multi-device is the canonical v2.
- **Access token readable by XSS for ≤ 15 min** — mitigation stack in
  ADR-0005 and the audit tripwire.
- **Metadata visible to the server** — inherent to routing.
- **Redis pub/sub is lossy** — live frames during a Redis blip are lost for
  that pod's sessions; clients resync by sequence on reconnect. Durability
  never depends on pub/sub (`SCALABILITY.md`).
- **Rate limiter fails open** — availability over strictness for a chat;
  logged when it happens.
- **Analytics counters are at-least-once** — a DB write per message to make
  a Prometheus counter exactly-once is the wrong trade; drift is bounded and
  visible in consumer-lag metrics.
- **In-app metrics dashboard is per-instance** — cluster-wide views are
  Prometheus/Grafana; the page says so.
- **AI features send room plaintext to an external API** — off by default
  (503 without a key), `AI_BASE_URL` points at an in-org gateway, and the
  call sits behind a circuit breaker.
- **No account lockout after N failed logins** — rate limiter + audit only;
  a deliberate choice against user-facing DoS.
- **No email-based password reset** — no mail sender in this version.

**What running the integration suite found (say this before they ask — it is the best story in the repo):**
- The Testcontainers suites were written before Docker was available and executed for the
  first time during the verification pass. Every one of them now passes (auth, messaging, DMs,
  STOMP, Kafka consumers, Kafka resilience), and getting there surfaced real defects the unit
  tests could not see: unauthorised STOMP `SUBSCRIBE` (any user could read any room), a
  signed-vs-unsigned UUID ordering bug that blocked roughly half of all DM pairs, an invalid Kafka
  producer timeout pair, a trusted-packages pattern the type mapper does not glob, a JSON
  `RecordMessageConverter` contributed by Modulith that rejected typed records, a DLT suffix
  mismatch, the outbox table missing from the Flyway-owned schema, and a Docker image that built
  but could not start (layered-jar launcher layout). Each has a test or a migration behind it now.
- `README.md` → *Verification status* lists exactly what has been executed, what is a design
  target, and what still needs infrastructure this repository does not own (a Kubernetes cluster,
  an AWS account, the Render account, a pushed commit for GitHub Actions).
- Throughput and connection-density numbers from the previous implementation are kept in the
  appendix and labelled; the Java backend's own numbers come from `load/k6-stomp.js` and are
  quoted only where that harness produced them.

**Known gaps an interviewer could press:**
- **Room text search is whole-word/stemmed**; short queries fall back to an
  escaped ILIKE scan bounded to the room.
- **Kafka partition count is a one-way door** — raising it needs a topic
  migration; 12 in prod is sized for the envelope with headroom.
- **`processed_events` retention (7 days) must exceed Kafka retention** for
  the ledger to be complete; both are configuration, documented together.

---

## Appendix — history of the previous (Node) implementation

Kept because the lessons transfer and because the measured numbers are the
only ones that exist until the harness is ported.

**Measured (single Windows laptop, Docker Desktop, everything co-located):**
- Connection density: **10,000/10,000 concurrent sockets held on one pod**,
  470 MB RSS, a message probe through the held load ACKed 200/200 at p50
  43 ms / p95 95 ms. Getting there found three bottlenecks — only one in the
  server: an unbounded presence-roster re-broadcast on every connect (fixed
  with a bounded payload and a throttled broadcaster — the design the Java
  `RosterBroadcaster` keeps); a single-process load generator starving its
  own event loop; a free-tier database throttling per-connect writes.
  "Knowing which of the three layers is failing — server, harness, or
  infrastructure — *is* the benchmark skill."
- k6, 50 VUs across 10 rooms via the LB: ACK p95 **176 ms** (p50 19 ms);
  the hot-room case (50× fan-out) reached p95 2.55 s — fan-out, not message
  rate, is the cost driver.
- Failover verifier: 60/60 exactly once across a killed socket-owning pod,
  gap ≈ 2.4 s, one reconnect per client.
- Hot-path A/B: send path from 4–5 DB round-trips to 1 → ACK p50
  284 → ~100 ms. The speedup exposed a latent sequence-counter race that the
  unique-index backstop caught — "optimizations change timing; timing
  changes expose races; backstops are why you have them." In the Java
  design the counter is Redis-atomic and the backstop is the same index.

**Remediations from earlier review passes that shaped the current design:**
sensitive-data detector order bugs; `myRole` populate-before-compare;
sending now records participation; per-device session list and revocation;
`$text` search replacing regex scans; cursor-only pagination; envelope size
cap derivation; graceful shutdown hanging on proxy keep-alives; explicit
reconnect after server-initiated disconnect; E2EE attachments with per-file
keys and presigned direct upload; Redis TTL typing indicators (a killed pod
can't leave ghost typers); TOTP 2FA with a scoped pending token the verifier
rejects structurally; and the best story of the pass — the recovery backup
was uploaded only at setup, so sessions created later were unrecoverable on
a new device; unit tests missed it, an end-to-end "new device" walk found it.
Each of these is either a constraint or a test in the Java implementation.
