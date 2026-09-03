# ADR-0010 — Replace the Node backend with a Java 21 / Spring Boot modular monolith

**Status**: accepted · **Supersedes**: parts of ADR-0001 (TypeScript backend), ADR-0002 (Redis behind interfaces — kept in spirit), ADR-0007 (delivery guarantees — kept, moved to Postgres backstops)

## Problem

The Node/Express/Socket.IO/MongoDB backend had grown a genuine reliability layer (dedup, sequences, ACK/retry, Redis adapter, 2FA, E2EE key directory) but three things kept undermining it:

1. **Invariants lived in application code.** Exactly-once persistence depended on in-memory or Redis state with non-unique Mongo indexes as a soft backstop; a restart or a Redis flush could hand out a duplicate sequence.
2. **Deploys were fragile.** Runtime floors (Node ≥ 20.19 via transitive deps), a dashboard-configured host, and a TypeScript build step that had to run in the right directory produced repeated failed deploys with no code change.
3. **The event side was ad hoc.** Notifications, analytics and audit were synchronous side effects or fire-and-forget promises — lost on crash, impossible to replay, adding latency to sends.

## Requirement

A backend where the guarantees the product advertises (provable delivery, operator-proof privacy, failure survival, content-free observability) are enforced by the platform — schema constraints, transactions, an outbox, idempotent consumers — rather than by discipline; and whose deployment is fully described by the repository.

## Decision

- **Java 21 + Spring Boot 4.1** with **Spring Modulith**: one deployable, modules with build-time-verified boundaries, event-driven coupling between them.
- **PostgreSQL** replaces MongoDB: unique indexes carry the exactly-once and replay invariants; Flyway owns the schema; Hibernate only validates.
- **Kafka via the Modulith outbox** for everything after commit (notifications, audit, analytics); consumers are idempotent through a `processed_events` ledger; retry + DLT.
- **Redis** keeps the coordination role (rate limits, sequence counters, dedup fast path, presence, typing, WebSocket fan-out) but never holds a source of truth.
- **STOMP over WebSocket** replaces Socket.IO; no polling fallback, therefore no sticky sessions; a single frontend adapter preserves the pages' socket API.
- **Same repository, same frontend**: the API surface moves to `/api/v1` with `id` in place of `_id`; the React app's pages and crypto are unchanged.
- **Infrastructure as code**: Dockerfile, Compose (with scale-out profile), Kubernetes manifests with HPA/PDB/probes, Terraform for AWS, a Render blueprint, and a CI pipeline that runs Testcontainers-backed integration tests.

## Trade-offs

| Chose | Over | Cost accepted |
|---|---|---|
| Modular monolith | microservices | single deploy unit; a bad release affects every module (mitigated by rolling updates, probes, PDB) |
| Spring Boot 4 (only line on Initializr) | Boot 3.x | newer ecosystem: Jackson 3 default, package moves, fewer blog posts; verified against the actual jars |
| PostgreSQL | MongoDB | migration of existing data is not automatic (no production data existed for the demo deployment) |
| Kafka | plain Spring events / a queue table | an extra managed service; justified by replay, independent consumer groups and DLT semantics |
| STOMP simple broker + Redis fan-out | external STOMP relay (RabbitMQ) | no message-broker features (durable subscriptions) — not needed; durability is Postgres + Kafka |
| Replacing in the same repo | a sibling repository | history shows the rewrite; `chat-back/` is removed once parity is verified |

## Consequences

- Every "cannot happen" in the docs maps to a constraint, a transaction boundary or a test — `DATABASE_DESIGN.md`, `KAFKA_DESIGN.md`.
- The interview story changes from "I added reliability features" to "the platform makes the guarantees, here is where each one lives."
- Local development needs Docker for Postgres/Redis/Kafka (Compose provided); unit tests do not.
- Frontend: one adapter file (`stompSocket.ts`) and a path/id sweep; the E2EE client code is untouched.
