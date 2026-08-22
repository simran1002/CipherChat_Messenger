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

1. **The kill-a-pod demo** — live proof, not slideware: stop a replica
   mid-conversation, zero messages lost or duplicated, sequence numbers
   intact on restart.
2. **RFC-vectored crypto** — an E2EE implementation whose every primitive is
   pinned to official test vectors in CI, with tamper/replay suites; almost
   no portfolio project does this.
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

**Known gaps an interviewer could press (be ready, or fix next):**
- **Uploads live on a shared Docker volume**, not object storage — fine for
  one org, S3+presigned URLs is the named milestone; media is also NOT E2EE
  in DMs (text envelopes only) — call it out before they do.
- **Search is regex-scan, not a text index** — escaped (ReDoS-safe) but
  O(room) per query; `$text` index is the next step, and E2EE DMs are
  client-side-search-only by definition.
- **No per-message rate limit on `/user/refresh` beyond the /user bucket**
  and no device/session listing UI for revocation — session *storage*
  supports it (one row per session); UI doesn't expose it yet.
- **k6 thresholds not yet run against the scale topology in this repo's
  history** (local Docker unavailable during the build); the script and
  thresholds exist — run once and paste numbers into WHY-DIFFERENT.md.
- **Legacy offset-pagination branch still in the messages endpoint** —
  kept deliberately for rollout compatibility; delete after clients are
  confirmed on cursors.
- **DM envelopes cap at ~16KB ciphertext** (server structural validation);
  fine for 2000-char texts, but the limit and its rationale should be
  stated in the envelope validator comment.
