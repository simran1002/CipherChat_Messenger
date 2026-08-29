# Interview Review — questions to expect, wow factors, weak points

A self-administered SDE-3 interview pass over this repository: the questions
a strong interviewer is likely to ask, the concept each one is really
probing, and an honest account of what impresses vs. what can be attacked.

---

## Questions an interviewer is likely to ask

### Architecture & scalability
| Question | Concept to explain (and where it lives) |
|---|---|
| "Walk me through what happens when I hit Send." | The 5-layer delivery pipeline: optimistic UI → ACK/retry → offline queue → Redis dedup → sequence + DB backstops (ADR-0007, ARCHITECTURE.md sequence diagram) |
| "Why sticky sessions? Doesn't that defeat load balancing?" | Socket.IO's long-polling fallback needs request affinity; fan-out between pods rides the Redis adapter, so stickiness affects only connection placement, not delivery (deploy/nginx-lb.conf) |
| "What breaks first as you scale?" | Named triggers in the scaling-milestones table: single Redis (>4 pods), synchronous persistence (>500 msg/s → queue), room hot-spotting (sharding). Knowing the *order* is the point |
| "Why not microservices?" | One org per deployment, tens of rps — a modular monolith with interface seams (shared/, services/) is the honest fit; the seams are where services would split if triggers fire |
| "Why Mongo and not Postgres?" | Document shape fits messages; the real answer is the invariants are enforced regardless: unique partial indexes, watermark rows, TTL indexes. Engineering is in the constraints, not the brand |

### Concurrency & consistency
| Question | Concept |
|---|---|
| "Two replicas receive the same retry simultaneously — what happens?" | Redis `SET NX` is the atomic arbiter; loser ACKs with the winner's id. DB unique index is the belt-and-suspenders (tests double-send deliberately) |
| "How do you order messages across replicas?" | Per-room Redis `INCR` — atomic, seeded from Mongo max on first touch so restarts never re-issue. Global order deliberately not promised |
| "Your rate limiter is read-modify-write — race?" | It isn't: the token bucket is a single Lua script, atomic in Redis; there's a concurrency test firing 30 parallel requests asserting exactly `capacity` admits |
| "Two browser tabs share IndexedDB ratchet state — corruption?" | Web Locks serialize counter reservation; counter-addressed decryption makes interleaving harmless (ADR-0003) |
| "markRead upsert races itself" | The `$lt`-guarded upsert can 11000 on first concurrent write; caught and retried as `$max` — idempotent by construction (chatroomController.markRead) |

### Security & crypto
| Question | Concept |
|---|---|
| "Why roll your own protocol instead of libsignal?" | ADR-0003's rejection table: web packaging, and the interview-honest reason — a correct, testable, honestly-scoped protocol demonstrates more than an integrated black box. Every primitive is audited (@noble), only the *composition* is mine, and the composition is vector-tested |
| "Where does forward secrecy actually stand?" | Session-granular (200 msgs / 7 days), not per-message. Stated plainly; upgrade path = DH-ratchet-as-new-session. Interviewers respect the honest boundary more than an inflated claim |
| "What stops me replaying a ciphertext into another conversation?" | AAD binds `{conversationId, senderId, sessionId, ctr}` — GCM tag fails; plus client counter dedup and a server unique index on (conversation, session, ctr) |
| "XSS steals the access token — then what?" | 15-minute blast radius, rotation-on-use refresh cookie is httpOnly, replay-after-rotation is the theft tripwire → 401 (ADR-0005). Known residual risk, documented |
| "Who can read room messages?" | The operator — on purpose. Two privacy tiers, honestly labeled; AI features require plaintext (ADR-0004). This is the strongest product-thinking answer in the repo |

### Testing, ops, performance
| Question | Concept |
|---|---|
| "How do you know the crypto is right?" | RFC 7748/8032/5869 + NIST GCM known-answer vectors pinned in CI, golden transcript fixtures, tamper/replay/out-of-order/rotation suites |
| "How do you test socket flows without mocks lying to you?" | Real server on an ephemeral port + real socket.io-client + mongodb-memory-server; the Redis suite runs against a real Redis service container in CI |
| "What's your p95 and how do you know?" | k6 script speaking raw engine.io frames, threshold p95<250ms @ ~100 msg/s on 2 pods; prom-client histograms in prod (buckets 5→2500ms) |
| "A pod dies mid-deploy — walk me through it." | SIGTERM → io.close → drain → mongoose disconnect; clients retry/queue; dedup absorbs replays; seeded counters prevent seq reuse; the demo literally kills a pod |
| "Why cursor pagination?" | offset/skip scans linearly with depth; `_id` cursors are O(log n) index seeks and stable under concurrent inserts (works for pre-sequence legacy rows too) |

---

## WOW factors

1. **The kill-a-pod demo, as an asserted test** — `npm run demo:failover`
   auto-detects the socket-owning replica, stops it at message #30 of 60,
   and asserts: 60/60 persisted exactly once, sequence numbers gap-free
   across the pod switch, both clients reconnected once, the in-flight
   message retried once onto the survivor, 0 duplicate deliveries. Measured
   failover gap ≈ 2.4 s; steady-state ACK p50 14 ms.
2. **RFC-vectored crypto, verified live** — every primitive is pinned to
   official test vectors in CI, with tamper/replay suites; and the full flow
   was exercised across two isolated browser origins: setup gate, recovery
   code, X3DH-lite `init` envelope, both chain directions decrypting live,
   matching 60-digit safety numbers, and a database holding only
   `e2ee/v1` ciphertext. Almost no portfolio project does either half.
3. **Five-layer delivery guarantee with a test that double-sends** — the
   exactly-once claim is executable, not aspirational.
4. **ADRs that reject alternatives** — every major choice names what it
   turned down (Double Ratchet, libsignal, Kafka, monorepo) and the cost
   accepted. This is the SDE-3 signal.
5. **Two privacy tiers as a product decision** — E2EE DMs vs server-readable
   AI rooms, with the trade-off argued instead of hidden.
6. **Interfaces with two real implementations** — the same test-covered
   contract runs in-memory (dev) and on Redis (prod), selected by config;
   CI exercises both.
7. **Content-free observability** — a metrics design constraint derived from
   the product's privacy promise, visible in a live dashboard.
8. **Theft-detecting refresh rotation** — replay of a rotated token is
   treated as a signal, not just an error.
9. **190-file TypeScript migration with typed socket event maps** — payload
   drift between client and server is a compile error.
10. **An honest threat model in the README** — including "a malicious client
    build served by the operator," which most web-E2EE products omit.

---

## Weak points (and their status)

**Remediated during this review:**
- ~~Sensitive-data detector missed "Your OTP is 123456" (order-sensitive) and
  bare `sk-…` keys~~ → patterns fixed for both orders + well-known bare key
  shapes; tests extended.
- ~~`getMembers` returned `myRole: null` for everyone~~ (populate-before-
  compare bug) → fixed with a regression guard.
- ~~Sending never recorded room participation despite the documented
  contract~~ → send path now ensures membership.
- ~~No session listing / revocation UI~~ → `GET/DELETE /user/sessions[/:id]`
  (owner-scoped, current-session flagged, "sign out everywhere else") +
  Active-sessions card on the profile page; 4 integration tests.
- ~~Search was an O(room) regex scan~~ → `$text` on the compound
  `{chatroom, message}` index ranked by score, escaped-regex fallback only
  for partial words / symbols.
- ~~Legacy offset-pagination branch~~ → removed; cursor-only endpoint, stray
  `?page` is ignored (tested).
- ~~Envelope size cap undocumented~~ → derivation comment (2000 chars → 8192B
  bucket + tag → ~10.9 KB base64; 16 KB cap) next to the validator.
- ~~Redis suite only ran in CI~~ → 9/9 verified locally against a real Redis
  container.
- ~~Graceful shutdown hung for the full 10 s grace and force-exited~~ — found
  by the kill-a-pod run: `server.close()` waits on the reverse proxy's idle
  keep-alive connections. Now `closeIdleConnections()` immediately and
  `closeAllConnections()` after a 2 s drain; the pod exits cleanly.
- ~~Failover demo was a manual eyeball~~ → `npm run demo:failover`
  (`chat-back/src/scripts/failoverCheck.ts`) stops a pod mid-stream and
  asserts exactly-once persistence, gap-free sequences, and exactly-once
  receipt on the other client. It also caught that the verifier (like any
  client) must handle `"io server disconnect"` explicitly — socket.io won't
  auto-reconnect after a server-initiated close; the app already did.
- nginx LB tuned for failover: `max_fails=2 fail_timeout=5s`,
  `proxy_connect_timeout 2s`, `proxy_next_upstream` on connect errors — a
  dead pod is sidelined in ~2 s instead of several, and retries are safe
  because the dedup layer makes replayed sends idempotent.

**Accepted and documented (defend, don't hide):**
- **Session-granular forward secrecy** — the honest Megolm-style trade
  (ADR-0003); upgrade path documented.
- **Single-device E2EE** — new browser = restore-with-recovery-code or
  reset-with-banner; multi-device is the canonical v2 (Signal shipped
  single-device first too).
- **Access token readable by XSS for ≤15 min** — mitigation stack in
  ADR-0005; full fix conflicts with the socket handshake.
- **Metadata visible to the server** — inherent to routing; padding buckets
  blunt size analysis only.
- **AI features send room plaintext to a third-party API** — off by default
  (no key configured, 503s gracefully); a self-hosted-LLM swap is the
  documented alternative for the target customer.

**Measured, with the caveats stated up front (from the k6 + failover runs):**
- **Hot-room fan-out is the real ceiling**: 50 users all typing in one room
  (50× fan-out ≈ 2,900 deliveries/s) pushed one pod to p95 2.55 s; the
  representative 10-room split met the 176 ms p95. Say it before they ask:
  "delivery load is sends × room size, and a single Node event loop tops out
  around a few thousand socket writes per second — the batching/Kafka
  milestone is gated on that, not on raw message rate."
- **IP-hash stickiness makes single-source load tests one-pod tests** —
  Prometheus showed `backend2` at zero during both k6 runs. That's a property
  of `ip_hash`, not a bug, but it means "2 pods" in the demo proves shared
  state + failover, while the throughput numbers are per-pod. The shipped
  websocket-only `least_conn` profile (`npm run stack:scale:ws`) removes the
  stickiness requirement entirely — the follow-up question is "why can you
  drop ip_hash there?", and the answer is "stickiness only ever existed for
  the long-polling fallback."
- **The `/user` rate limiter (100/15 min/IP, Redis-shared) bites load-test
  setup** — 50 registrations per run from one IP; documented in the script.
  Proof the limiter is cluster-wide; also a reminder that test harnesses need
  either token reuse or an explicit bypass in non-prod.

- ~~Uploads lived on a shared Docker volume~~ → `IFileStorage` with
  `local` and `s3` drivers (`STORAGE_DRIVER`, any S3-compatible endpoint
  incl. MinIO/R2), multer → memory, replaced avatars reclaimed, S3 driver
  unit-tested with an injected fake client (ADR-0008).
- ~~`/user/refresh` shared the generic `/user` bucket~~ → dedicated 30/15 min
  limiter on top.

- ~~Frontend tests covered hooks/services/crypto but no components~~ → 44
  Testing-Library render tests (RoomMembersPanel, E2EESetupGate,
  SafetyNumberModal, MetricsDashboardPage) with framer-motion/recharts stubbed.
- ~~Golden E2EE transcript lived only inside a test~~ → committed
  `src/crypto/fixtures/golden-transcript.json` (RFC-vector private scalars,
  fixed ephemeral + sessionId); tests assert every envelope decrypts AND that
  re-sealing is byte-identical — a second implementation needs only the JSON.
- ~~"KATs against both noble and WebCrypto"~~ → interchangeability suite:
  AES-256-GCM / HKDF / HMAC computed via `crypto.subtle` and via noble on the
  same vectors are byte-identical and cross-decrypt; X25519 shared secrets
  agree between WebCrypto keys and noble (Node 20 supports it).
- ~~`SocketContext` coexisted with `socket` props~~ → props removed; Header
  and every page read `useSocket()`.
- ~~No Vite dev proxy~~ → same-origin default + proxy for API prefixes and
  `/socket.io` (ws); fresh clone needs no `.env`, dev has no CORS.
- ~~Recovery code dismissible with one click~~ → explicit "I have written this
  code down" acknowledgement gates the continue button (test pins it).
- ~~`markVerified` silently no-op'd without a pin while the badge flipped~~ →
  now throws; the modal's existing error path shows it.
- ~~No demo recording in the README~~ → real-output terminal render (SVG) of
  the failover PASS, linked to the reproducible script.

- ~~DM attachments were not E2EE~~ → each file is sealed client-side with its
  own AES-256-GCM key and uploaded as `application/octet-stream` to a
  dedicated `/upload/encrypted` route; key/IV/name/MIME/size travel only
  inside the E2EE envelope (a `__dmc` JSON content protocol that keeps plain
  text byte-compatible). The server can't learn even the file *type*.
  Tamper = GCM failure rendered as an inline error. Tests: round-trip,
  fresh-key-per-file, tamper/wrong-key, hostile-JSON fallback, route
  MIME-isolation.
- ~~Attachment ciphertext transited the API pod~~ → `POST
  /upload/encrypted/presign` + browser-direct PUT when object storage is
  configured; the signature pins content type AND exact byte length, so the
  server-side size cap holds bucket-side too. Local driver answers 501 and
  the client falls back to the proxied route — tests cover both paths on
  both sides (ADR-0008).
- ~~Typing TTL timers were per-pod (a killed pod could leave ghost
  typers)~~ → Redis TTL keys + keyspace notifications: every pod hears the
  expiry and clears its local sockets, so the indicator dies with the key,
  not with the pod. Falls back to per-pod timers where `CONFIG SET` is
  disabled (managed Redis); exercised against real Redis in CI.
- ~~`least_conn` was documented-only~~ → shipped as a compose override +
  `deploy/nginx-lb-ws.conf` with websocket-only clients
  (`VITE_SOCKET_TRANSPORTS=websocket`), since stickiness only ever served
  the long-polling fallback.
- ~~The room header claimed "end-to-end encrypted"~~ — leftover copy from
  before the E2EE split that contradicted the documented threat model (rooms
  are deliberately server-readable, ADR-0004). Caught while screenshotting;
  now says "exactly-once delivery", which rooms actually guarantee. The
  lesson stated plainly: every privacy claim in the UI must match the
  architecture, or the whole threat model reads as marketing.
- ~~The Vite proxy shadowed the app's `/metrics` route in dev~~ — hard
  reloads served the backend's Prometheus text instead of the dashboard page
  (the dashboard's data comes from `/analytics`; the prefix never belonged
  in the proxy list).

**Performance-engineering pass (measured A/B, same harness):**
- The message send path performed **4–5 MongoDB round-trips per message**
  (room doc, sender doc, watermark upsert, membership guard, insert). Now:
  a 15s-TTL room-summary cache (invalidated on membership mutations),
  sender info from the presence registry (DB only as fallback), watermark +
  participation writes moved off the latency path, and the offline-drain
  loop's per-item sender lookup hoisted (was 50 queries per drain). DM sends
  similarly: immutable participants cached, `lastMessageAt` fire-and-forget.
- **A/B on the identical harness** (20 senders × 1/s, one room,
  `scripts/loadgen.mts`, dev server + Atlas): ACK RTT p50 **284 → ~100 ms**,
  p95 **489 → ~195 ms** — the remaining ~100 ms is the single message-insert
  RTT to Atlas, i.e. the floor.
- **The speedup exposed a latent race** (the best part of the story): the
  in-memory SequenceCounter interleaved read → await-seed → write, so
  concurrent sends on a cold room drew duplicate sequence numbers once the
  extra DB fetches stopped accidentally serializing them. The DB's unique
  `{chatroom, sequenceNumber}` backstop caught it exactly as designed (the
  flood test failed 19/30 with server_error). Fixed with a single-flight
  seed + synchronous increment; two regression tests pin it. "Optimizations
  change timing; timing changes expose races; backstops are why you have
  them" — say this sentence in the interview.
- Frontend: emoji-mart's dataset now lazy-loads on first picker open —
  chatroom chunk **526 → 107 KB** (gzip 130 → 30); React/motion split into
  long-cacheable vendor chunks (first-load gzip ≈ −38%).

**Known gaps an interviewer could press (be ready, or fix next):**
- **E2EE DMs are client-side-search-only** by definition (the server holds
  ciphertext); room search uses the `$text` index. Worth stating as a
  feature of the threat model, not a gap.
- **`/user/refresh` shares the generic `/user` rate bucket** (100/15 min) —
  adequate, but a dedicated tighter bucket would blunt token-guessing noise
  further. One-line change; not done only to keep the auth ADR stable.
- **Room text search is whole-word/stemmed** — partial matches fall back to
  the escaped regex scan, so very short queries still cost O(room).
