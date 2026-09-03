# Interview Demo Script (10–15 minutes)

Audience: senior/staff engineers. The goal is not a product tour — it's to
surface the engineering under the UI fast, and let every step open a thread
they can pull on. Rehearse the kill-a-pod step; it's the centerpiece.

**Setup before the call:**

```bash
docker compose -f docker-compose.yml -f docker-compose.scale.yml up --build --scale backend=2
```

nginx `least_conn` → 2 backend replicas → shared Postgres + Redis + Kafka; app
on :3000, API through the LB on :8080. Two users in two *isolated* browser
contexts — easiest trick: open `http://localhost:3000` as user A and
`http://127.0.0.1:3000` as user B in the same browser. They're different
origins, so localStorage/IndexedDB (and therefore E2EE keys) are fully
separate. Terminal visible. Metrics page open in a third tab. `psql` handy:
`docker compose exec postgres psql -U cipherchat`.

---

### 1. Problem statement (1 min)
"Small orgs with sensitive conversations — legal, healthcare, journalism —
can't put them in a third-party SaaS. Self-hosting solves custody but not
trust in the operator, and self-hosted is where nodes die with nobody on
call. So: provable delivery, operator-proof DMs, failure survival,
observability that never sees content." (docs/WHY-DIFFERENT.md)

### 2. Why it's hard (1 min)
Name the two classic failure modes: lost messages and duplicated messages.
Everything else in the demo is the machinery that makes both impossible —
and the point of the rewrite: the machinery is now **constraints and
transactions**, not application discipline.

### 3. Architecture in one diagram (1 min)
README diagram. Point at exactly three things: Postgres is truth (unique
indexes carry the guarantees), Redis is coordination (never a source of
truth), Kafka is "afterwards" (outbox → consumers). One deployable, module
boundaries enforced by a test (`ModularityTests`).

### 4. Live: delivery pipeline (2 min)
Send messages between the two browsers. Narrate the tick progression
(◌ sending → ✓ ACKed → ✓✓ delivered → blue read). DevTools → Network → WS:
show the STOMP `SEND /app/rooms/send` frame carrying `clientMessageId` and
the ACK on `/user/queue/acks` carrying `sequenceNumber`. Then in psql:

```sql
\d messages            -- point at the two unique indexes
select id, sequence_number, client_message_id from messages order by id desc limit 5;
```

"If Redis lied about the sequence, this index refuses the row. The ACK is a
promise the database keeps."

### 5. Live: kill a pod (2 min) — centerpiece
```bash
docker compose ps                                # find the replica holding the sockets (backend logs show CONNECT)
docker compose kill cipherchat-backend-1         # while one browser is typing
```
Clients reconnect to the survivor through the LB within seconds, the offline
queue drains through `/app/rooms/sync`, dedup absorbs the retries — zero
lost, zero duplicated. Show `docker compose logs -f lb` and the reconnect in
the console. Restart the pod; its next message gets the right sequence
(counter seeded from `max(sequence_number)`, never reset to 1).

Talking point: no sticky sessions anywhere. "The socket is pinned by TCP,
not by the LB; everything *about* the session lives in Redis or Postgres."

### 6. Live: offline queue (1 min)
DevTools → Network → Offline. Send three messages (⏳ queued badge). Back
online → they drain in order, exactly once. Application tab → IndexedDB →
show the queue emptying. Then send the same message twice with the same
`clientMessageId` from the console — the second ACK says `duplicate: true`.

### 7. Live: E2EE (2 min)
DM between the two users. Show: the WS frame carries only
`{v, sessionId, ctr, ct}`. In psql:

```sql
select type, body, envelope from dm_messages order by id desc limit 1;
```

"This is what the DB admin sees." Safety-number modal: same 60 digits in
both browsers. Then the server's *only* cryptographic duties: `\d dm_messages`
→ the `(conversation, sender, sessionId, ctr)` unique index — "a counter is
spent once, cluster-wide, even with a hostile client"; `PUT /api/v1/keys`
verifies the Ed25519 prekey signature so the directory can't serve a
mix-and-match bundle. One sentence on the protocol: "X3DH-lite handshake,
per-direction HMAC chains, GCM with routing-bound AAD, session rotation every
200 messages — ADR-0003 has the Double-Ratchet and libsignal rejection
rationale."

### 8. Live: the afterwards pipeline (1 min)
@mention the other user in a room. Their toast is instant (Redis fan-out);
then `GET /api/v1/notifications` shows the durable inbox row that came
**through Kafka**. In psql: `select * from event_publication order by
publication_date desc limit 3;` (the outbox) and `select * from
processed_events;` (the idempotency ledger). "Stop Kafka, send a message —
it still ACKs; the publication waits in Postgres and replays when the broker
is back."

### 9. Rooms vs DMs trade-off (30 s)
Open a room, hit AI summarize. "Rooms are server-readable on purpose — you
can't summarize what you can't read. Two privacy tiers, honestly labeled."
(ADR-0004) Mention the circuit breaker: kill the API key → three endpoints
return a fast 503, nothing else notices.

### 10. Authorization + unread (1 min)
Create a private room; show the other user can't see it (403 with a stable
`code`), invite them, show role management and the owner-transfer rule.
Dashboard unread badges — one watermark row per (user, room), badge = indexed
range-count.

### 11. Observability (1 min)
Metrics page: p50/p95/p99, delivery rate, live concurrency. `curl
localhost:8080/actuator/prometheus | grep cipherchat_` for the Prometheus
view; `curl -H 'X-Request-Id: demo-1' …` and grep the JSON log line for it.
"Every metric passes one test: could this line reveal what someone said?"

### 12. Tests + CI (1 min)
`./mvnw verify` — Testcontainers start real Postgres/Redis/Kafka; point at
`MessagingIT` (double-send → one row, gapless sequences), `DirectMessageIT`
(replayed counter → 409), `KafkaConsumersIT` (mention → inbox row exactly
once), `StompGatewayIT` (ACK + broadcast over a real socket), and
`ModularityTests` (module boundaries). Client crypto is pinned to RFC/NIST
vectors; server TOTP to RFC 6238. CI: Spotless → unit → ITs → JaCoCo → Trivy
→ images → gated deploy.

### 13. Trade-offs I'd defend (1 min)
Pick three: modular monolith over microservices at this envelope; Redis
pub/sub (lossy, resync by sequence) for live fan-out instead of Kafka;
session-granular forward secrecy over a subtly-wrong Double Ratchet. Each has
an ADR with the alternative it rejected (ADR-0010, 0007, 0003).

### 14. Open threads for Q&A
`SYSTEM_DESIGN.md` §10 (what changes at 10×), the weak-points list in
`INTERVIEW-REVIEW.md` — offering your own known limitations before being
asked is the strongest signal in the room.
