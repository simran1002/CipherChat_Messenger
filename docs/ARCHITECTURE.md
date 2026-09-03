# Architecture

CipherChat is a **modular monolith**: one deployable Spring Boot service whose internals are split into modules with compiler-and-test-enforced boundaries (Spring Modulith). It talks to PostgreSQL (truth), Redis (coordination), Kafka (durable downstream work) and object storage (attachments). The React SPA is a separate static deployment.

## Why a modular monolith and not microservices

The envelope (`SCALABILITY.md`) is one organisation, ≤ 10k concurrent sessions, ~200 msg/s. Splitting auth, rooms, DMs and presence into services would add network hops to the hottest path (a send touches auth, membership, sequence, persistence and fan-out), require distributed transactions or sagas where today a single `@Transactional` suffices, and multiply the operational surface for no scaling benefit at this size.

What the monolith keeps from the service world:

- **Boundaries are enforced**, not aspirational: `ModularityTests` fails the build if `dm` reaches into `chatroom` internals or `gateway` depends on a module it did not declare.
- **Modules communicate through events** where coupling would otherwise be synchronous (`shared.events`), and those events are the same records that go to Kafka — so a module could be extracted later by moving its consumer, without redesign.
- **Independently scalable concerns** are already separate processes: Postgres, Redis, Kafka, the SPA.

## Module map

```
                         ┌─────────────── shared (OPEN) ───────────────┐
                         │ api · security · events · infra · kafka · web│
                         └──────────────────────────────────────────────┘
        ▲            ▲             ▲            ▲           ▲          ▲
   ┌────┴───┐   ┌────┴────┐   ┌────┴─────┐  ┌───┴──┐   ┌────┴───┐  ┌───┴────┐
   │  user  │◀──│  auth   │   │ chatroom │  │  dm  │   │  keys  │  │ upload │
   └────────┘   └─────────┘   └──────────┘  └──────┘   └────────┘  └────────┘
        ▲            ▲             ▲            ▲
        │       ┌────┴─────────────┴────────────┴────┐        ┌────────────┐
        │       │            gateway (STOMP)         │        │  presence  │
        │       └────────────────────────────────────┘        └────────────┘
        │                                                          ▲
        └──────────────────────────────────────────────────────────┘

   Kafka consumers (no inbound dependencies):  notification · audit · analytics
   Outbound HTTP:                              ai (→ Anthropic, behind a circuit breaker)
```

| Module | Owns | Depends on |
|---|---|---|
| `user` | accounts, profiles, presence status column, directory | shared |
| `auth` | login/register, JWT, refresh rotation, sessions, 2FA, audit publishing | user |
| `chatroom` | rooms, membership & roles, messages, receipts, watermarks, search, exactly-once send | user |
| `dm` | conversations, E2EE envelopes, replay backstop | user |
| `keys` | E2EE key directory, prekey verification, recovery blob | user |
| `presence` | online registry, heartbeats, typing TTLs, roster | user |
| `gateway` | STOMP endpoint, frame handlers, Redis fan-out bridge, roster broadcaster | chatroom, user, presence, dm, auth |
| `upload` | storage drivers (local, S3), presigned PUT | — |
| `ai` | summaries, suggestions, tone | chatroom |
| `notification` | durable inbox (Kafka consumer + REST) | — |
| `audit` | append-only audit log (Kafka consumer + admin REST) | — |
| `analytics` | Micrometer counters (Kafka consumer), admin overview, dashboard feed | — |

`shared` is an OPEN module: cross-cutting types with no business logic (`ApiException`/ProblemDetail mapping, `AuthenticatedUser`/`CurrentUser`, the event records, Redis primitives, Kafka policy, correlation-id filter).

## Request paths

### Send a room message (the hot path)

```
client ─ STOMP SEND /app/rooms/send ─▶ gateway.StompController
   │                                        │ validate frame
   │                                        ▼
   │                               chatroom.MessageService.send
   │                                 1. assertAccess (membership)
   │                                 2. Redis token bucket        rl:msg:<user>
   │                                 3. Redis dedup lookup         dedup:<clientId>  ─▶ duplicate? ACK(dup)
   │                                 4. Redis INCR seq:<room>      (seeded from DB max)
   │                                 5. tx { INSERT message; upsert watermark; INSERT event_publication }
   │                                    └─ unique indexes: (room,seq), clientId   ─▶ race? resolve to existing row
   │                                 6. Redis SET NX dedup mark
   │                                        │
   ◀── ACK /user/queue/acks ────────────────┘
                                        after commit:
                                        ├─ MessageSent → Kafka message-events (outbox)
                                        └─ MessageSent → gateway.DomainEventFanout → Redis PUBLISH ws:room:<id>
                                                                                          │
                                                every pod: RedisFanout.onMessage → SimpMessagingTemplate → /topic/rooms/<id>
```

The client's view: ACK within one DB round-trip; the broadcast arrives on every replica a few ms later; the notification inbox and analytics catch up through Kafka whenever they like.

### Direct message (E2EE)

Same shape minus the sequence (DMs are id-ordered), plus `EnvelopeValidator` and the `(conversation, sender, sessionId, ctr)` unique index. The server stores and forwards ciphertext; the `dmNotification` toast to the recipient contains sender and "encrypted", never content.

### Login

`AuthService.login` → BCrypt (dummy-hash on unknown email) → 2FA enabled? scoped pending token : refresh cookie + 15-min JWT → `Audited` event (detached on failure so the rollback cannot erase it).

## Real-time layer

- **Transport**: STOMP over raw WebSocket at `/ws` (no SockJS — every target browser has WebSockets; long-polling fallbacks are what forced sticky sessions in the previous implementation).
- **Broker**: Spring's simple broker for `/topic`, `/queue`; app destinations `/app/**`; user destinations `/user/**` resolved by principal name = user id.
- **Auth**: `StompAuthInterceptor` parses the bearer token on `CONNECT`; unauthenticated frames are rejected in the inbound channel before any handler runs.
- **Cross-pod**: `RedisFanout` publishes `{event, payload}` frames to `ws:room:*`, `ws:dm:*`, `ws:user:*`, `ws:all`; each pod's listener forwards to its local broker. Pods are otherwise unaware of each other.
- **Presence**: connect/disconnect events → `PresenceService` (Redis hash per user with session count + TTL) → throttled `RosterBroadcaster`. Heartbeats every 25 s self-heal after a TTL expiry.
- **Frontend adapter**: `chat-front/src/services/stompSocket.ts` presents the Socket.IO-shaped `emit/on` surface the pages use and maps it onto destinations/subscriptions — one file knows both vocabularies.

## Data & messaging infrastructure

- **PostgreSQL** — see `DATABASE_DESIGN.md`. Flyway migrations; Hibernate validates against them.
- **Redis** — rate-limit buckets (Lua), per-room sequence counters, dedup keys, presence, typing TTLs, WS fan-out pub/sub. Nothing in Redis is a source of truth; every Redis fact has a Postgres backstop or is reconstructible (`SCALABILITY.md`).
- **Kafka** — see `KAFKA_DESIGN.md`. Outbox → topics keyed by conversation → idempotent consumer groups with retry + DLT.
- **Object storage** — `FileStorage` driver interface; `local` for dev, `s3` (AWS or MinIO) with presigned PUT so encrypted attachments never transit the app.

## Cross-cutting

- **Errors**: `ApiException(status, code, message)` → RFC 9457 ProblemDetail with `code`, `timestamp`, `requestId`; validation errors add a `fields` map. Codes are stable strings the client keys on (`rate_limited`, `replayed_counter`, …).
- **Correlation**: `X-Request-Id` accepted or generated, placed in MDC, echoed in responses and problem bodies; the nginx LB injects one when the client sent none.
- **Observability**: Actuator health (liveness/readiness with DB/Redis/Kafka indicators), Prometheus at `/actuator/prometheus`, app metrics `cipherchat.*` (`AppMetrics`), structured JSON logs (`LOG_FORMAT=ecs`) in prod, module-level observation via Modulith insight.
- **Resilience**: Resilience4j circuit breaker + retry on the Anthropic client; Kafka retry/DLT; rate limiter fails open; fan-out failures are logged, never propagated to the sender.
- **Configuration**: everything via environment variables with dev defaults (`application.yaml`); the `prod` profile refuses default secrets and forces secure cookies.

## Boundaries with the previous implementation

The Node/Express/Socket.IO/MongoDB backend (`chat-back/`) is replaced wholesale; its shared-module ideas (dedup, sequence counter, token bucket, presence heartbeat, roster throttling, offline queue drain) are carried over as Redis-backed Java components with database backstops, and its API surface is preserved under `/api/v1` with `id` replacing Mongo's `_id`. The frontend keeps its pages and crypto; only the transport adapter and API paths changed.
