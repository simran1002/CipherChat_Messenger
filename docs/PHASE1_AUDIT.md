# Phase 1 — Audit of the previous implementation

Snapshot taken before the Java rewrite. Kept as the record of *why* each change in ADR-0010 was made.

## Architecture as found

- `chat-back/` — Node 20/22, Express 4, TypeScript (recently migrated from CommonJS), Socket.IO 4, Mongoose/MongoDB Atlas, optional Redis (`ioredis` behind interfaces, in-memory fallback), `prom-client` metrics, Anthropic SDK for room AI features, multer uploads (local disk or S3), otplib-free self-implemented TOTP, Ed25519 verification via `@noble/curves`.
- `chat-front/` — React 19 + Vite + TypeScript + Tailwind; pages talk to `/user`, `/chatroom`, `/dm`, `/keys`, `/upload`, `/ai`, `/presence`, `/analytics`; Socket.IO client singleton via context; E2EE implemented client-side (`src/crypto`), offline queue in IndexedDB.
- Deploy: Render web service configured in the dashboard (no blueprint), MongoDB Atlas M0, Redis optional; Docker/Compose files existed for local scale-out demos.

## Tech-stack observations

| Area | Finding | Consequence |
|---|---|---|
| Persistence | Mongo indexes for `clientMessageId` and `(chatroom, sequenceNumber)` were not unique until late; DM messages had lived in an unbounded embedded array before being split out | exactly-once relied on process state; migrations by script |
| Coordination | Redis implementations existed but the in-memory fallback was the default path locally and on the demo host | scale-out claims were only true with `REDIS_URL` set |
| Events | notifications/analytics/audit were inline or fire-and-forget | lost on crash, not replayable, on the send path |
| Real-time | Socket.IO with polling fallback → `ip_hash` sticky sessions in one LB profile, `websocket`-only in another | two operational modes to explain |
| Auth | JWT 15 min + rotating refresh (good); role not signed into the token | admin paths unreachable in practice |
| Runtime | transitive Node floors (`@noble/hashes` ≥ 20.19, rolldown ≥ 20.19/22.12) | deploys failed on hosts with older Node |
| Tests | ~285 tests incl. crypto KATs and socket integration; MongoDB via memory server | good coverage of the *client* crypto and of the socket layer; DB invariants untested because they were not invariants |

## Render deployment failure — analysis

**Symptom**: repeated "deploy failed" emails; the dashboard log was not captured.

**Contributing causes (evidence-based)**:
1. Service configuration lived in the Render dashboard: root directory, build command and start command predated the `chat-back/src` + TypeScript layout. A correct commit could not fix a stale command.
2. Node version on the host below the transitive floor introduced by `otplib → @noble/hashes` (≥ 20.19) and by Vite 8/rolldown (≥ 20.19 / 22.12). Locally masked by nvm's Node 23.
3. No `render.yaml`, so no way to review or revert deploy configuration.

**Root cause**: deploy configuration outside the repository, exposed by a repository layout and runtime-floor change.

**Fix (Phase 2+)**: `render.yaml` blueprint with a Docker runtime built from `backend/Dockerfile` (Java 21 pinned in the image), health check on Actuator readiness, managed Postgres/Redis wired by reference, secrets marked `sync: false`. Verified locally by building the image; a live Render deploy requires the user's account.

## Verification performed in Phase 1

- Read every route, controller, model and socket handler in `chat-back/src` to enumerate the API surface and event contract (recorded in `docs/API.md` under the new paths).
- Read the frontend's API call sites (45) and socket usages (61 across 7 files) to size the integration change.
- Confirmed the Node floors from the lockfile (`engines` fields of the transitive packages).
