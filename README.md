# CipherChat Messenger

![CI](https://github.com/simran1002/CipherChat_Messenger/actions/workflows/ci.yml/badge.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Tests](https://img.shields.io/badge/tests-170%2B-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

**Self-hostable secure team messaging** for organizations that can't put
sensitive conversations in a third-party SaaS — with provable message
delivery, end-to-end encrypted DMs, horizontal scale-out, and observability
that never sees content.

> **Why this exists and what makes it different:** [docs/WHY-DIFFERENT.md](docs/WHY-DIFFERENT.md)
> **Architecture + diagrams:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
> **Decision records (with rejected alternatives):** [docs/adr/](docs/adr/)
> **10-minute demo script:** [docs/DEMO.md](docs/DEMO.md)

---

## The four load-bearing guarantees

| Guarantee | Mechanism | Proof |
|---|---|---|
| **Exactly-once persistence** over at-least-once transport | client UUID + ACK/retry w/ backoff → IndexedDB offline queue → Redis `SET NX` dedup → per-room `INCR` sequences → DB unique-index backstops | integration test double-sends the same UUID and asserts one row; kill-a-pod demo |
| **Operator-proof DMs** | X3DH-lite handshake, per-direction HMAC-SHA256 chains, AES-256-GCM with routing-bound AAD, 256-byte padding, session rotation (200 msgs / 7 days), safety numbers, 8-word recovery code | crypto pinned to RFC 7748 / 8032 / 5869 + NIST GCM vectors; tamper/replay/out-of-order/rotation tests; `db.dmmessages.find()` shows only ciphertext |
| **Failure survival** | 2+ replicas behind nginx `ip_hash`, `@socket.io/redis-adapter` fan-out, per-user rooms, seeded sequence counters, graceful `SIGTERM` drain | `docker compose -f docker-compose.scale.yml stop backend1` mid-conversation: zero lost, zero duplicated |
| **Content-free observability** | prom-client histograms + counters per pod, in-app live metrics dashboard (`/metrics` route), k6 load thresholds | every metric passes "could this reveal what someone said?" — counts, latencies, outcomes only |

## Feature surface

- **Rooms** (server-readable team spaces): membership + roles
  (owner/admin/member), private rooms with invites, unread watermarks with
  dashboard badges, @mentions with cross-replica notifications, virtualized
  message list with cursor pagination, pinned messages, full-text search,
  reactions, replies, edit/delete, self-destruct TTL messages, typing
  indicators with server-side TTL (no ghost typers), presence with
  heartbeat (no ghost online), AI summaries / reply suggestions / tone
  (Claude), file/voice/location messages.
- **DMs** (end-to-end encrypted): everything the server can't read —
  encrypted sidebar preview cache, key-change banners, safety-number
  verification, restore/reset flows, offline queue of pre-sealed envelopes,
  legacy-plaintext history clearly demarcated.
- **Auth:** 15-minute access tokens + rotating refresh cookie (hashed at
  rest, replay-after-rotation → 401), silent refresh, socket re-auth on
  reconnect.

## Quickstart

```bash
# Full stack (Mongo + Redis + backend + frontend)
docker compose up --build          # app → http://localhost:3000

# Horizontal-scaling demo (nginx LB → 2 backend replicas)
docker compose -f docker-compose.scale.yml up --build
docker compose -f docker-compose.scale.yml stop backend1   # the party trick
```

Local development without Docker:

```bash
cd chat-back && npm i && npm run dev     # needs DATABASE + SECRET in .env
cd chat-front && npm i && npm run dev    # VITE_API_URL in .env
```

Without `REDIS_URL` the backend runs single-node on in-memory
implementations of the same interfaces — Redis is required only for
multi-replica deployments (see [ADR-0002](docs/adr/0002-redis-behind-interfaces.md)).

## Tests & CI

```bash
cd chat-back && npm test    # unit + socket integration (mongodb-memory-server)
cd chat-front && npm test   # hooks, offline queue (fake-indexeddb), crypto KATs
k6 run load/k6-chat.js      # threshold p95 ACK < 250ms; measured 176ms @ 59 msg/s, 10 rooms (see docs/WHY-DIFFERENT.md)
cd chat-back && npm run demo:failover   # stops the socket-owning pod mid-stream, asserts zero loss / zero dupes
```

CI (GitHub Actions): typecheck, lint, full test suites (the Redis
implementation suite runs against a real Redis service container), builds,
and both Docker images.

## Threat model (DMs)

| Protects against | How |
|---|---|
| Server operator / DB dump reading DMs | ciphertext-only storage; keys never leave the browser |
| Network attacker | TLS + E2EE; AAD binds ciphertext to conversation/sender/session/counter |
| Ciphertext tampering or replay | GCM tag over AAD; client counter dedup + server unique `(conversation, session, ctr)` index |
| Key theft from a stolen DB | prekeys are public; refresh tokens & backups stored hashed/wrapped |

| Does NOT protect against | Why |
|---|---|
| Metadata (who ↔ whom, when, sizes beyond padding buckets) | routing requires it |
| A malicious client build served by the operator | inherent to web-delivered E2EE — stated, not hidden |
| Room content vs the operator | deliberate: server-side AI needs plaintext ([ADR-0004](docs/adr/0004-e2ee-dms-only.md)) |

## Repository layout

```
chat-back/    Express + Socket.IO + Mongoose (TypeScript, strict)
  src/sockets/       typed event maps + per-domain handlers
  src/shared/        reliability layer: interfaces + in-memory + Redis impls
  src/storage/       file storage: interface + local-disk + S3-compatible drivers
  src/services/      room authorization authority
  tests/             unit + integration (mongodb-memory-server, socket.io-client)
chat-front/   React 18 + Vite + Tailwind (TypeScript, strict)
  src/crypto/        E2EE: primitives (RFC-vectored), X3DH-lite, chains, envelopes
  src/services/      E2EEService, offline queue (IndexedDB v2), API client
docs/         WHY-DIFFERENT · ARCHITECTURE · DEMO · INTERVIEW-REVIEW · adr/
deploy/       nginx LB config          load/    k6 script
```

MIT licensed.
