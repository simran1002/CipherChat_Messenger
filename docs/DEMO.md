# Interview Demo Script (10–15 minutes)

Audience: senior/staff engineers. The goal is not a product tour — it's to
surface the engineering under the UI fast, and let every step open a thread
they can pull on. Rehearse the kill-a-pod step; it's the centerpiece.

**Setup before the call:** `docker compose -f docker-compose.scale.yml up
--build` (nginx LB → 2 backend replicas → shared Mongo + Redis; app on
:3000). Two browsers (or one normal + one incognito) logged in as two users.
Terminal visible. Metrics page open in a third tab.

---

### 1. Problem statement (1 min)
"Small orgs with sensitive conversations — legal, healthcare, journalism —
can't put them in a third-party SaaS. Self-hosting solves custody but not
trust in the operator, and self-hosted is where nodes die with nobody on
call. So: provable delivery, operator-proof DMs, failure survival,
observability that never sees content." (docs/WHY-DIFFERENT.md)

### 2. Why it's hard (1 min)
Name the two classic failure modes: lost messages and duplicated messages.
Everything else in the demo is the machinery that makes both impossible.

### 3. Architecture in one diagram (1 min)
docs/ARCHITECTURE.md topology diagram. Point at exactly three things: sticky
LB, Redis as the coordination plane, per-user rooms for cross-pod targeting.

### 4. Live: delivery pipeline (2 min)
Send messages between the two browsers. Narrate the tick progression
(◌ sending → ✓ ACKed → ✓✓ delivered → blue read) and what each transition
proves. DevTools → Network → WS: show the `chatroomMessage` frame carrying
`clientMessageId` and the ACK carrying `sequenceNumber`.

### 5. Live: kill a pod (2 min) — centerpiece
**Stop the pod that owns the sockets.** nginx `ip_hash` routes by client IP,
and from one laptop every browser shares an IP — so hard-coding `backend1`
usually kills the *other* replica and proves only shared state, not socket
failover. `curl localhost:8080/health` returns `pod` = the socket owner.

Two ways to run it:
- **Automated (do this first, it's the proof):** `cd chat-back && npm run
  demo:failover` — registers two users, streams 60 messages, stops the
  socket-owning pod at #30, and asserts exactly-once persistence, gap-free
  sequences, and exactly-once receipt on the other client. Expect
  `reconnects alice=1 bob=1`, a few `retried sends` absorbed by dedup, PASS.
- **Visual:** `docker compose -f docker-compose.scale.yml stop <that pod>`
  while one browser types. The clients reconnect to the survivor (via the
  LB), the offline queue drains, dedup absorbs the retries — zero lost, zero
  duplicated. Show `docker compose ps` and the reconnect in the console.
  Restart the pod and show it rejoining with correct sequence numbers
  (seeded from Mongo, not reset to 1).

Talking point: the first run of the verifier *found two real bugs* — the
graceful shutdown hung on proxy keep-alives, and a client must explicitly
reconnect after a server-initiated disconnect. Both fixed; both are in
INTERVIEW-REVIEW.md. "The demo is also a test" is the SDE-3 line.

### 6. Live: offline queue (1 min)
DevTools → Network → Offline. Send three messages (⏳ queued badge). Back
online → they drain in order, exactly once. Application tab → IndexedDB →
show the queue emptying.

### 7. Live: E2EE (2 min)
DM between the two users. Show: the WS frame carries only
`{v, sessionId, ctr, ct}`; `mongosh` → `db.dmmessages.findOne()` shows
ciphertext at rest ("this is what the DB admin sees"). Safety-number modal:
same 60 digits in both browsers. One sentence on the protocol: "X3DH-lite
handshake, per-direction HMAC chains, GCM with routing-bound AAD, session
rotation every 200 messages — ADR-0003 has the Double-Ratchet and libsignal
rejection rationale."

### 8. Rooms vs DMs trade-off (30 s)
Open a room, hit AI summarize. "Rooms are server-readable on purpose — you
can't summarize what you can't read. Two privacy tiers, honestly labeled."
(ADR-0004)

### 9. Authorization + unread (1 min)
Create a private room; show the other user can't see it, invite them, show
role management and the owner-transfer rule. Dashboard unread badges — one
watermark row per (user, room), badge = indexed range-count.

### 10. Observability (1 min)
Metrics page: p50/p95/p99, delivery rate, live concurrency. `curl
localhost:8080/metrics | grep cipherchat` for the Prometheus view. "Every
metric passes one test: could this line reveal what someone said? Counts,
latencies, outcomes only."

### 11. Tests + CI (1 min)
`npx vitest run` in chat-back (unit + socket integration on
mongodb-memory-server; the dedup test literally double-sends a UUID). Point
at the crypto KAT file: RFC 7748/8032/5869 + NIST GCM vectors. CI runs the
Redis suite against a real Redis service container. k6 script with the
p95<250ms threshold.

### 12. Trade-offs I'd defend (1 min)
Pick three: session-granular forward secrecy (vs a subtly-wrong Double
Ratchet), Redis as a single coordination point (vs premature Kafka), access
token in localStorage for 15 minutes (vs breaking the socket handshake).
Each has an ADR with the alternative it rejected.

### 13–14. Open threads for Q&A
Scaling milestones table (what changes at 100× and what triggers it), the
weak-points list in docs/INTERVIEW-REVIEW.md — offering your own known
limitations before being asked is the strongest signal in the room.
