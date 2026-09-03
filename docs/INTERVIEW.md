# Interview Guide — 24 questions, 30–90 seconds each

Answers are written to be said aloud. Every claim points at the file, test
or measurement that backs it; where something is a design rather than a
measurement, the answer says so. Companion: `INTERVIEW-REVIEW.md` (likely
questions, wow factors, weak points) and `DEMO.md` (the live walkthrough).

### 1. Why Java / Spring Boot?

The guarantees this product sells are transactional: a message row, a
watermark and an outbox row must commit together, and consumers must claim
an idempotency ledger row in the same transaction as their side effect.
Spring's transaction model, JPA plus Flyway, Spring Kafka and Spring
Modulith give that in one well-understood stack, and Java 21 virtual threads
make the blocking JDBC/Redis calls on the hot path cheap to hold. The
previous Node implementation had the same ideas but enforced them by
discipline; here they are constraints and transactions.

### 2. Why a modular monolith instead of microservices?

One organisation per deployment and roughly 200 messages per second is not a
scaling problem, it is a correctness problem. A send touches auth,
membership, sequence allocation, persistence and fan-out; as services that
is five hops and a saga where today it is one `@Transactional`. The monolith
keeps the service-style boundaries: Spring Modulith fails the build on an
undeclared dependency (`ModularityTests`), and modules talk through the same
event records that go to Kafka, so a module can be extracted later by moving
its consumer. ADR-0010.

### 3. Why PostgreSQL?

Because the guarantees are unique indexes: `(chatroom_id, sequence_number)`,
`client_message_id`, `(conversation, sender, sessionId, ctr)`,
`lower(email)`, `(user_low, user_high)`. Postgres makes those first-class and
transactional with the outbox row. UUID keys for anything in a URL, BIGINT
identity for messages so the id doubles as a cursor. Flyway owns the schema;
Hibernate only validates against it.

### 4. Why Redis?

For the state that must be shared across stateless replicas but is never
the source of truth: the Lua token bucket, the per-room `INCR` sequence
counter (seeded from the database high-water mark), the `SET NX` dedup key,
presence hashes with TTL, typing-indicator TTL keys, and pub/sub for
cross-replica WebSocket fan-out. Every Redis fact has a Postgres backstop or
is reconstructible, which is what makes Redis failure survivable.

### 5. Why Kafka?

For everything that must happen after a message is durably stored but must
never delay or fail the send: notification inboxes, the audit trail,
analytics. Those consumers may be slow, down, or need replaying. The
producer side is a transactional outbox (Spring Modulith's event
publication table), so Kafka being down does not fail a send; the consumer
side is idempotent through a ledger. `KafkaConsumersIT` watches a mention
become exactly one inbox row through a real broker.

### 6. Why Redis Pub/Sub instead of Kafka for WebSocket fan-out?

Consumer-group semantics are the wrong shape: with Kafka, one replica would
receive each event, and every replica needs every event because any replica
may hold the recipient's socket. You would need a consumer group per
replica and pay Kafka's latency floor for a frame that is lossy by design.
Redis pub/sub delivers to all subscribers now; durability is Postgres plus
Kafka, and a client that missed frames resynchronises by sequence on
reconnect.

### 7. How is message ordering guaranteed?

Per room, not globally. A Redis `INCR` hands out the next sequence; it is
seeded once from `max(sequence_number)` in Postgres, so a restarted Redis
never restarts at one. If the counter is ever wrong, the unique index on
`(chatroom_id, sequence_number)` refuses the second writer instead of
producing two messages in one slot. History pages are cursor scans on that
index. `MessagingIT` asserts gapless sequences after a retry.

### 8. How is duplicate sending handled?

The client attaches a UUID `clientMessageId` and retries until it gets an
ACK; an IndexedDB queue holds it offline. Server side: a Redis `SET NX`
answers retries within ten minutes from cache; the partial unique index on
`client_message_id` catches anything that slipped past Redis; a
`DataIntegrityViolationException` is resolved to the existing row in a
`REQUIRES_NEW` transaction, and the ACK says `duplicate: true`.
`MessagingIT` and `StompGatewayIT` double-send and assert one row and one
broadcast.

### 9. What happens when Redis fails?

Rate limiting fails open (logged). Dedup falls through to the unique index.
The sequence counter cannot be allocated, so room sends fail closed with a
503 until Redis returns, which is better than guessing a slot. Live fan-out
pauses; clients resync by sequence on reconnect. Presence goes stale until
TTLs expire. Nothing durable is lost and no message state can be corrupted,
because Redis never held the truth.

### 10. What happens when Kafka fails?

Sends are unaffected. The outbox row commits with the message; the
publication is retried and, if the JVM restarts, republished on startup
(`republish-outstanding-events-on-restart`). Notifications, audit rows and
analytics counters lag until the broker returns, then catch up. Readiness
reports the dependency so an orchestrator can see it.

### 11. What happens when PostgreSQL fails?

Sends fail with a 503 and nothing else pretends to work: readiness fails,
the pod is pulled from the load balancer, and on AWS RDS Multi-AZ fails
over. Clients keep their offline queue and drain it, idempotently, when the
database is back. There is deliberately no cache that could serve a stale
"success".

### 12. How does horizontal scaling work?

Every backend pod is interchangeable: no in-JVM state another pod would
need. Add pods behind a `least_conn` balancer; Redis coordinates counters,
buckets and presence; every pod subscribes to the Redis fan-out channels;
Kafka consumer groups rebalance across pods up to the partition count. The
HPA scales on CPU, with open WebSocket sessions documented as the better
signal.

### 13. Why no sticky sessions?

Because a WebSocket is already sticky by TCP; nothing else needs to be. HTTP
requests carry a stateless JWT, and a reconnecting socket may land on any
pod because everything about the session lives in Redis or Postgres. Sticky
sessions in the previous implementation existed only to make long-polling
fallbacks work; STOMP over a raw WebSocket removed the fallback.

### 14. How does WebSocket authentication work?

The access token is sent as a STOMP `CONNECT` header, never in the URL that
proxies log. `StompAuthInterceptor` verifies it once and sets a principal
whose name is the user id, which is what routes `/user/queue/...`. On
`SUBSCRIBE` the same interceptor checks room membership for
`/topic/rooms/{id}` and conversation participation for `/topic/dm/{id}`;
any other destination is refused. `StompGatewayIT` proves an outsider's
subscription to a private room delivers nothing.

### 15. How does JWT refresh work?

Access tokens live 15 minutes. The refresh token is a random 256-bit value
stored only as a SHA-256 hash, in an httpOnly `SameSite=Lax` cookie scoped
to `/api/v1/auth`. Refresh consumes the row atomically and issues a new
pair; presenting a consumed token yields a 401 and an audit event, because
a replay is the signature of theft. Each row is one device, so users can
list and revoke sessions, and a password change revokes the others.
`AuthFlowIT` replays a rotated cookie and asserts the 401.

### 16. How does TOTP work?

RFC 6238: the seed is a random 160-bit secret shown as a QR/base32 string;
each 30-second step HMAC-SHA1s the counter and truncates to six digits; the
server accepts the current step plus one either side for clock drift. The
seed is sealed at rest with AES-256-GCM under a key derived from
`SEAL_SECRET`, so a database dump cannot generate codes. Login with 2FA
enabled returns a scoped pending token that every API path rejects; only
`/login/2fa` accepts it. `TotpTest` checks the RFC test vectors.

### 17. How is E2EE enforced?

The client does the cryptography (X3DH-lite handshake, per-direction HMAC
chains, AES-256-GCM with routing-bound AAD, padding, session rotation). The
server enforces the three things it can: it verifies the Ed25519 prekey
signature before storing a bundle so it cannot serve mixed bundles, it
validates envelope structure with hard size caps, and the unique index on
`(conversation, sender, sessionId, ctr)` spends each counter once
cluster-wide, so a replayed or forged counter gets `409 replayed_counter`.
Previews and notifications for DMs are content-free by construction.

### 18. How does the transactional outbox work?

An event is a Java record annotated `@Externalized`. Spring Modulith writes
it to the `event_publication` table inside the producing transaction; after
commit, a listener hands it to Kafka with `acks=all` and an idempotent
producer, and completes the row on acknowledgement. There is no window in
which the message exists without the event or the event without the
message, and a crash between commit and publish is healed by republishing
incomplete rows on restart.

### 19. How does consumer idempotency work?

Kafka is at-least-once: rebalances, crashes after the side effect but before
the offset commit, and retries all redeliver. Each consumer inserts
`(consumer, event_id)` into `processed_events` with `ON CONFLICT DO NOTHING`
inside the same transaction as its side effect; if the insert loses, the
handler returns without doing anything. The claim is `Propagation.MANDATORY`
so a handler that forgets `@Transactional` fails loudly instead of
duplicating silently. Offsets commit after the handler returns.

### 20. What would you change at 10× traffic?

Read replicas for history and search; Kafka partitions from 12 to 48 with a
topic migration; a dedicated Redis for presence; monthly partitioning of
`messages`. None of it changes the schema or the module layout, and the
triggers for each are named in `SYSTEM_DESIGN.md` §10.

### 21. What would you change at 100× traffic?

That is a different product, multi-tenant SaaS, and I would say so rather
than pretend the single-org design stretches. Concretely: shard by
organisation, move fan-out to a purpose-built pub/sub tier with
per-connection backpressure, split the gateway into its own deployable (the
module boundary already exists), and revisit E2EE for large rooms with
sender keys.

### 22. What are the current bottlenecks?

The single Postgres writer, idle at the envelope but the one thing that does
not shard. Fan-out cost in very large rooms (every message is one frame per
online member). The in-memory STOMP broker per pod, fine at thousands of
sessions per pod, not at hundreds of thousands. The Kafka partition count as
a one-way door.

### 23. What is actually measured?

See "Verification status" in `README.md` for the current table. In short:
the unit suite, the Modulith boundary test and the Testcontainers
integration suites (auth, messaging, DMs, Kafka consumers, STOMP) execute
on every build; the Compose stack is brought up and exercised end to end;
the k6 STOMP harness in `load/` produces the latency numbers quoted there.
Any number not produced by that harness is labelled as a design target or
as a measurement of the previous implementation.

### 24. What remains unverified?

Anything that needs infrastructure this repository does not own: the
Kubernetes manifests are schema-validated but not applied to a cluster; the
Terraform is formatted and validated but not planned or applied against an
AWS account; the Render blueprint builds locally but the hosted deploy was
not observed; GitHub Actions is structurally correct but has not run on a
pushed commit. Each is marked NOT VERIFIED in the README rather than
implied.
