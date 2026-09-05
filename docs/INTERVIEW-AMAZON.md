# CipherChat — Amazon SDE deep-dive and Bar Raiser preparation

Everything below is grounded in the repository as it is. Where the honest answer is "designed, not measured", say so in the room; a Bar Raiser rewards precision about what you verified far more than a bigger number you cannot defend.

**Actual stack:** Java 21 · Spring Boot 4.1 · Spring Modulith 2.1 (build-enforced module boundaries, transactional outbox) · Spring Security (stateless JWT, rotating refresh sessions, TOTP 2FA) · Spring WebSocket + STOMP · Spring Data JPA / Hibernate 7 · Flyway · PostgreSQL 17 · Redis 7 (Lettuce) · Apache Kafka (KRaft) · Resilience4j · Micrometer/Prometheus · React 19 + TypeScript client with Web Crypto E2EE · Docker (layered, non-root) · Compose · Kubernetes (kustomize: HPA, PDB, probes) · Terraform (EKS, RDS, ElastiCache, MSK, S3) · Render · GitHub Actions (CI, Release, Deploy, CodeQL, Dependabot) · Testcontainers · k6.

---

## 1. System architecture and deep-dive

### The 90-second walkthrough (say it in this order)

1. **Edge.** Browser speaks HTTPS for REST and WSS for STOMP to an L7 balancer (nginx `least_conn` locally, ALB/Ingress in Kubernetes). **No sticky sessions**: every replica is stateless, so the balancer can pick any pod for any connection.
2. **Gateway.** Spring Boot pods terminate WebSocket. Authentication happens once, at STOMP `CONNECT`, with the short-lived JWT; every `SUBSCRIBE` to a room or DM topic is authorised against membership on the server. A pod holds only the session table for its own sockets.
3. **Send path (hot path, synchronous).** `POST` or STOMP `SEND` carries a client-generated UUID (`clientMessageId`). The pod checks a Redis dedup cache, takes a per-room sequence number from Redis `INCR`, and inserts the row in PostgreSQL under two unique indexes: `(client_message_id)` and `(chatroom_id, sequence_number)`. The database, not the cache, is what makes delivery exactly-once.
4. **Fan-out.** After commit, the pod publishes to Redis pub/sub; every pod receives it and delivers to the sockets it owns for that room. The sender gets an ACK on its private queue carrying the sequence number and a `duplicate` flag.
5. **Afterwards (asynchronous).** Everything that is not the message itself (mention notifications, audit trail, analytics) is written to a transactional outbox in the same DB transaction as the message, relayed to Kafka, and consumed by idempotent consumers with a processed-events ledger, exponential retry and a dead-letter topic per consumer.
6. **State of record.** PostgreSQL owns everything durable. Redis is coordination only and is never authoritative; if it disappears, the system degrades by policy, it does not corrupt.

Close with the one-liner: *"Redis makes the common case fast, Kafka makes the side effects reliable, and PostgreSQL makes the guarantees true."*

### Scaling to 100K concurrent WebSocket connections: bottlenecks and answers

Be explicit about what is measured on the Java gateway ([BENCHMARKS.md](BENCHMARKS.md)): 5,000 sockets held on one pod with zero failures at about 97 KB of heap each, send → ACK p95 54 ms and broadcast p95 64 ms at 43 msg/s, and a broadcast to all 5,000 members of a single room taking p50 1.0 s / p95 6.6 s because the simple broker delivers serially. 10,000 was not completed on the shared VM, and 100K is a design exercise from those measurements. Then reason it out:

| Bottleneck | Why it bites | What the design does / would do |
|---|---|---|
| Per-connection memory on the pod | Each socket costs buffers plus session objects; at 100K per pod you are in the multi-GB range and GC pauses hurt tail latency | Cap at roughly 10–20K sockets per pod and scale horizontally; the HPA is on CPU today, the honest next metric is an open-sessions gauge (already exported as `cipherchat_ws_sessions`). ZGC is on in the image to keep pauses short |
| Heartbeats | STOMP heartbeats every 10 s at 100K sockets is 10K frames per second of pure overhead per direction | Longer heartbeat intervals on the client, rely on TCP keepalive plus a server-side idle reaper |
| Presence and roster broadcasts | A naive "broadcast the full roster on every join" is O(N²) and was the first thing that fell over at 10K in the earlier implementation | Throttled, batched roster deltas with a Redis TTL per user; presence is eventually consistent by design |
| Redis pub/sub as the fan-out bus | Single-threaded and unsharded; every pod subscribes to every channel, so cost grows with pods × message rate | Shard channels by room (Redis Cluster sharded pub/sub) or move fan-out to Kafka partitions keyed by room; pods subscribe only to rooms with local sessions |
| Sequence allocation | One `INCR` per message on one Redis | It is atomic and cheap (~100K ops/s); shard by room across Redis nodes long before it saturates. It fails closed to `503 redis_unavailable` rather than inventing sequences |
| Database writes | One insert per message | Batched outbox relay, indexes limited to the ones that carry guarantees, read replicas for history. Partition `messages` by room hash when it grows |
| Connection storms | A deploy or a balancer failover reconnects 100K clients at once | Graceful drain on `SIGTERM` (readiness goes down first, `PodDisruptionBudget` limits simultaneous pod loss), client reconnect with jittered exponential backoff, JWT validation is local (no auth-service round trip) |
| File descriptors and ephemeral ports | The balancer needs a source port per backend connection | Raise `nofile`, multiple balancer IPs, keep the balancer L7 so it can multiplex |

Why sticky sessions are not the answer: they only help if state lives on the pod. Here it does not; a reconnect to a different pod is a normal event, which is also what makes rolling deploys and kill-a-pod safe.

### Offline messages, delivery on reconnect, and acknowledgement

- **Durability first.** A message is acknowledged only after the PostgreSQL commit. Fan-out is best-effort on top of a durable log; a socket that was down misses the push, never the message.
- **Ordering is a number, not a timestamp.** Every room has a gapless monotonic `sequence_number`. The client remembers the highest sequence it has rendered per room.
- **Reconnect protocol.** On reconnect the client resubscribes, then pages history with "everything after sequence N". Any gap it notices in live traffic (it receives 41 after 39) triggers the same fetch. Ordering and completeness come from the sequence, so the client never trusts arrival order.
- **Sender-side retries.** The client keeps an outbox keyed by `clientMessageId` and resends on reconnect. The server answers `duplicate: true` with the original sequence; nothing is inserted twice. This is exactly-once *persistence* over an at-least-once *transport*, which is the only honest way to say "exactly-once".
- **Read state.** A per-user, per-room watermark (`last_read_sequence`) gives unread counts as one grouped query joined to the watermark; it replaced an N+1 that the integration tests surfaced.
- **Delivery receipts and notifications** ride the outbox to Kafka, so an offline user's mention becomes a durable notification row exactly once even if the consumer crashes mid-way (ledger + retry + DLT).

### Schema design for low-latency queries

- `messages(id, chatroom_id, sender_id, sequence_number, client_message_id, body, created_at, …)` with `UNIQUE(chatroom_id, sequence_number)` (which is also the history index: "after N" is an index range scan, `LIMIT 51` for the next page) and `UNIQUE(client_message_id)` for dedup; expression index on `to_tsvector('english', body)` for search.
- `room_read_state(chatroom_id, user_id, last_read_sequence)`: unread = count of rows with `sequence_number > watermark`, grouped by room in a single query.
- `conversations(user_low, user_high)` with a CHECK that `user_low < user_high` and a unique pair, so a DM pair is one row regardless of who starts it. (A real bug here is in the Dive Deep story below.)
- `dm_messages(conversation_id, sender_id, envelope jsonb)` with `UNIQUE(conversation_id, sender_id, (envelope->>'sessionId'), (envelope->>'ctr'))` as the E2EE replay backstop; "latest per conversation" is `DISTINCT ON (conversation_id) … ORDER BY id DESC` over an index.
- `event_publication` (outbox), `processed_events` (consumer ledger), `notifications`, `audit_logs`.
- Presence and typing are **not** in PostgreSQL: Redis keys with TTLs, because they are ephemeral and lossy by nature.
- Flyway owns the schema, including the outbox tables, because Hibernate schema validation runs before framework initialisers and the tests caught that ordering.

---

## 2. Security and cryptography

### Key exchange and message encryption, exactly as implemented

- **Identity.** Each user generates an X25519 identity key pair and an Ed25519 signing key in the browser (Web Crypto plus audited curve implementations; the primitives are pinned to RFC/NIST test vectors in unit tests). Private keys never leave the device; the server stores public bundles only.
- **Prekeys.** A signed prekey (X25519) is published with an Ed25519 signature by the identity key. The **server verifies that signature** before it will serve the bundle, so it cannot hand out a mix-and-match bundle it assembled itself. Identity changes bump a `keyVersion`; peers see a "safety number changed" banner.
- **Session setup (X3DH-lite).** Initiator fetches the peer bundle, runs the Diffie-Hellman combinations over identity and signed prekey, derives a session root with HKDF. No server-side one-time prekeys in this version; say that plainly if asked.
- **Message keys.** Per-direction HMAC-SHA256 chains; each message key is derived by HKDF from the chain at counter `ctr` and the chain advances, so a message key is used once and then discarded.
- **Cipher.** AES-256-GCM. The AAD binds the ciphertext to `{v, conversationId, senderId, sessionId, ctr}`, so a ciphertext cannot be replayed into another conversation, attributed to another sender, or reordered without failing authentication. Plaintext is padded to 256-byte buckets to blunt length analysis. Attachments use the same scheme.
- **Envelope on the wire and at rest** is opaque JSON: version, session id, counter, ciphertext. The server stores it as `jsonb` and never has a key that could open it.

### Perfect forward secrecy and key rotation: the precise claim

- **Within a session** the chain ratchet gives forward secrecy per message: compromising the device *now* does not reveal message keys that were already advanced past and deleted.
- **Sessions rotate every 200 messages or 7 days**, which bounds the blast radius of a compromised session and provides post-compromise recovery at rotation boundaries.
- **What it is not:** there is no per-message Diffie-Hellman ratchet (Signal's Double Ratchet), so post-compromise security is per-rotation rather than per-round-trip. If pressed, the roadmap answer is "add a DH ratchet step on direction change; the envelope already carries session and counter, so the wire format does not change."
- **Server-side keys** (JWT signing key, the `SEAL_SECRET` that wraps TOTP seeds under AES-256-GCM) are environment secrets; production refuses to start on default values. Refresh tokens are 256-bit random, stored as SHA-256 only, rotated on every use with an atomic consume, so a replayed refresh yields 401 and an audit event.

### Identity without seeing plaintext (the zero-knowledge shape)

- **Authentication is separate from encryption.** The server proves *who is on the socket* (BCrypt-12 password, optional TOTP where the password alone only yields a scoped pending token that every API path rejects, then a short-lived HS256 JWT). It never proves *what they said*.
- **The server's entire cryptographic contribution to a DM is a unique index.** It validates envelope structure, verifies the prekey signature in the key directory, and enforces `UNIQUE(conversation, sender, sessionId, ctr)` so a counter is spent once cluster-wide. It cannot decrypt, cannot forge (no sender keys), and cannot replay (index).
- **What the server can still do**, and you should volunteer it: it sees metadata (who talks to whom, when, ciphertext sizes modulo padding) and it could serve a malicious key bundle to a *new* peer. The mitigations are the signature check, the `keyVersion` banner, and out-of-band safety-number comparison. There is no multi-device support and no key escrow; losing the device loses history, by design.

---

## 3. Leadership Principles: three STAR stories from this project

Numbers below are the real ones from the repository's verification pass. Say them as ranges if you prefer, but do not inflate them.

### Dive Deep: running the integration suite for the first time

- **Situation.** The Java backend had 23 Testcontainers integration tests written, but Docker was unavailable when they were authored, so they had never executed. Unit tests were green and the code "looked right".
- **Task.** Before claiming exactly-once delivery or an authorised real-time layer, I needed those suites to run against real PostgreSQL, Redis and Kafka and to pass.
- **Action.** I got Docker working, ran the suite, and refused to mock my way past failures. That surfaced three classes of defect the unit tests structurally could not see: (1) any authenticated user could `SUBSCRIBE` to any private room or anyone's DM topic, because the STOMP interceptor authenticated `CONNECT` but never authorised `SUBSCRIBE`; (2) direct messages failed for roughly half of all user pairs with a 500, because the conversation pair was ordered with Java's signed `UUID.compareTo` while the database CHECK constraint compares unsigned bytes; (3) every Kafka event dead-lettered, from four stacked causes: a producer timeout pair that violated Kafka's own invariant, a trusted-packages pattern the deserialiser does not glob, a JSON record converter contributed by a framework module that rejected typed records, and a dead-letter suffix that changed between framework versions. Each fix became a test: a 10,000-random-pair ordering property test, an outsider-subscribe test asserting *nothing* is delivered, and Kafka resilience tests that deliver the same event twice, inject a poison record, and make a side effect fail until it dead-letters.
- **Result.** 23/23 integration tests green locally and on the hosted CI runner; a documented list of nine defects, two of them serious, each with a regression test; and a README table that states per claim whether it was executed, designed, or unverified.

*Alternative Dive Deep, if the interviewer prefers performance:* the first load run showed broadcast p95 of 6–10 s while the send handler averaged 130 ms. I refused the easy answer ("the VM is slow") and instrumented downward: Hikari showed `active=20, pending=40` with every Postgres session idle, so connections were parked, not busy; a thread dump caught the fan-out listeners opening `REQUIRES_NEW` transactions for a Redis publish; Hikari's leak detector then pointed at senders blocked in AFTER_COMMIT behind my own executor cap. Three fixes, each verified by re-measuring: broadcast p95 went from 6–10 s to 64 ms without touching the hot path itself.

### Invent and Simplify: exactly-once without a distributed lock

- **Situation.** The first design for "no duplicate messages" used sticky sessions plus in-memory dedup on the socket server. It worked on one node and broke the moment a client reconnected to a different node; it also made rolling deploys unsafe.
- **Task.** Guarantee exactly-once persistence and gapless ordering across any number of replicas without coordination on the hot path.
- **Action.** I moved the invariant out of the process and into data: a client-generated UUID per message, a Redis `INCR` per room for the sequence, and two unique indexes in PostgreSQL as the backstop. Then I defined the failure policy per Redis use instead of one blanket rule: the dedup cache **fails open** (the unique index still catches duplicates, only latency suffers), the sequence counter **fails closed** (a 503 is better than an invented sequence), and the rate limiter fails open. The socket layer became stateless, which deleted sticky sessions, the in-memory dedup map, and the drain logic that protected it.
- **Result.** Any replica can serve any client; kill-a-pod is a routine event rather than a data-loss scenario; the duplicate-send test asserts one row and a `duplicate: true` ACK; and the mechanism is explainable in one sentence to anyone who reads the schema.

### Bias for Action with Customer Obsession: shipping a verifiable MVP

- **Situation.** The target users are organisations that cannot put conversations in a third-party SaaS (legal clinics, healthcare practices). They need the guarantees more than they need scale on day one, and they need to be able to *check* the guarantees.
- **Task.** Ship a deployable, secure version quickly without hiding what was unfinished.
- **Action.** I made explicit compromises and wrote them down: a modular monolith instead of microservices (module boundaries enforced by the build, so the split is possible later); one Render instance with a local storage driver for the demo and an S3 driver ready for anything durable; a per-instance metrics page rather than a Prometheus cluster; Kafka partition counts chosen once with the note that it is a one-way door. I did not compromise on the invariants: unique indexes, replay backstop, outbox, authorised subscriptions. And I published a verification table that says which claims were executed, which are designed, and which still need infrastructure the repository does not own, plus a single script that runs the unverified runtime phases end to end.
- **Result.** A working deployment, a release pipeline (versioned jar, scanned images, SBOMs, GitHub Release), and a README a security-minded customer can audit instead of trust. When the first real CI run found three critical Tomcat CVEs and 37 base-image CVEs, the same posture applied: patch, re-scan, ship, and record it.

---

## 4. Failure modes and edge cases: the five hardest questions

**1. "Redis dies, or worse, splits into two masters, in the middle of a send. What happens to ordering and duplicates?"**
Three cases. *Redis down:* dedup falls open to the unique index (a duplicate costs one rejected insert instead of a cache hit); the sequence allocator fails closed and the send returns `503 redis_unavailable`, so no sequence is ever invented. *Redis restarts empty:* the first `INCR` would restart at 1; the fix is to seed the counter from `MAX(sequence_number)` in PostgreSQL on a miss, and even without it `UNIQUE(chatroom_id, sequence_number)` rejects the collision and the client retries. *Split-brain (two masters):* two pods can receive the same sequence for the same room; exactly one insert wins the unique index, the other gets a constraint violation, re-`INCR`s and retries. The database is the arbiter; Redis is only an optimisation for the common path. Say the guiding rule: coordination in Redis, truth in PostgreSQL.

**2. "Messages arrive out of order at a client, or a pod is partitioned from Redis pub/sub so its clients never receive the fan-out. How does the client end up correct?"**
Clients never trust arrival order; they trust the sequence. Every frame carries the room sequence, the client renders by sequence and detects gaps (it holds 41 while 40 is missing) and fills them from the history endpoint. A partitioned pod's clients miss pushes but the messages are committed, so the next heartbeat failure, reconnect, or gap detection reconciles them. Fan-out is therefore allowed to be lossy; durability is not. The residual risk is a client that receives nothing and sees no gap because *all* new messages were missed; the answer is the periodic "latest sequence per room" check on reconnect and a bounded heartbeat that forces reconnect when the socket is silently dead.

**3. "The WebSocket drops after the server committed the message but before the ACK reached the sender. The client resends. Walk me through it, including the Kafka side."**
The resend carries the same `clientMessageId`. The pod checks the dedup cache (or, if Redis is cold, hits the unique index) and returns `duplicate: true` with the original sequence; no second row, no second fan-out. The Kafka side effects were written to the outbox in the *same transaction* as the original insert, so they exist exactly once regardless of how many times the client retries. If the drop happened mid-handshake instead (before `CONNECT` succeeded), nothing was authenticated or sent; the client's outbox just retries after reconnect with backoff and jitter so 100K clients do not synchronise.

**4. "A Kafka consumer performs its side effect, then crashes before committing its offset. On restart it gets the same event. Also, what does a poison record do?"**
Delivery is at-least-once; the *effect* is exactly-once because the consumer inserts into the `processed_events` ledger and performs the side effect inside one PostgreSQL transaction. If it crashed before the offset commit, the redelivered event finds its ledger row and is skipped. The integration test delivers the same event twice and asserts one notification row and one ledger claim. A record that cannot be deserialised goes straight to the dead-letter topic with no retries; a side effect that keeps failing is retried at 0.5, 1, 2 and 4 seconds and then dead-lettered, with no ledger row so a replay from the DLT can succeed later. The thing to volunteer: the ledger is keyed by event id, so producers must generate stable ids, which the outbox does.

**5. "The server is compromised, or the operator is malicious. What can they do to an E2EE conversation, and what can they not?"**
They cannot read past or future ciphertext: no keys exist server-side, and AES-GCM with routing-bound AAD means a modified or transplanted ciphertext fails authentication. They cannot replay: the counter index spends each `(session, ctr)` once, cluster-wide, and the test proves the 409. They cannot forge a message as a user, because authentication of the socket is not authorship of a ciphertext. What they *can* do is serve a malicious key bundle to a peer who has never talked to the victim, or drop or delay messages, or read metadata. The mitigations, in order of strength: the identity-signed prekey that the server itself verifies (so a mixed bundle is rejected), the `keyVersion` bump that raises a safety-number-changed banner on every existing peer, and out-of-band safety-number verification for the paranoid. The honest gap is that a first contact has no prior trust anchor (TOFU); say that and say what fixes it (key transparency log or out-of-band verification).

Two more that a Bar Raiser often adds, with one-line answers:

- *"Two replicas both think they own a socket after a balancer failover."* They cannot: the socket is a TCP connection to exactly one pod; the old pod sees a close, the new one sees a fresh `CONNECT`. Presence flaps briefly because it is TTL-based, which is the accepted cost.
- *"Rolling deploy with 100K sockets."* Readiness drops first, the pod stops accepting, existing sockets get a STOMP `ERROR`/close with a retry hint, `PodDisruptionBudget` limits how many pods drain at once, and clients reconnect with jitter. Messages sent during the window are committed by whichever pod is up; ordering is by sequence, so nothing depends on which pod delivered it.

---

## What not to claim

- On the Java gateway: 5,000 sockets held (measured), 10,000 not completed on the shared VM; the 10,000 figure belongs to the previous Node implementation. Say exactly that.
- Latency is measured at 43 msg/s (ACK p95 54 ms, broadcast p95 64 ms); 200 msg/s was not driven. The measurement itself found four load-only defects (hashing inside a transaction, fan-out queued behind the connection pool, an unbounded then caller-blocking executor, fan-out sharing an executor with Kafka) — that story is a better Dive Deep than any number.
- The Compose chaos drills, two-replica fan-out, `EXPLAIN` plans and the hosted Render deploy are scripted and documented, not observed; CI on the hosted runner *has* executed the full integration suite and published scanned images and a release.
- There is no Double Ratchet, no one-time prekeys, no multi-device, no key transparency. Each has a one-sentence roadmap answer above.
