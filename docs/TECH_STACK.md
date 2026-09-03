# Tech stack

Every technology in the repository, what it is used for, and where it lives. Versions are the ones pinned in `backend/pom.xml`, `chat-front/package.json`, the Dockerfiles and the workflows.

## Backend platform (Java)

| Technology | Version | Role | Where |
|---|---|---|---|
| Java | 21 (Temurin) | Language; records, sealed types, virtual-thread-ready | `backend/` |
| Spring Boot | 4.1.1 | Application framework, auto-configuration, Actuator | `backend/pom.xml` |
| Spring Modulith | 2.1 | Module boundaries enforced at build time; event publication registry (transactional outbox) | `com.cipherchat.*` packages, `ModularityTest` |
| Spring Web MVC | via Boot | REST API under `/api/v1`, problem+json errors | `*Controller` |
| Spring WebSocket + STOMP | via Boot | Real-time gateway on `/ws`, per-user queues, room/DM topics | `com.cipherchat.gateway` |
| Spring Security | via Boot | Stateless JWT filter chain, CORS allow-list, method security | `com.cipherchat.shared.security` |
| Spring Data JPA / Hibernate | 7 | Persistence, `@Version` optimistic locking, JSONB columns | `*Repository`, entities |
| Flyway | via Boot | Owns the schema: every table, index, constraint, outbox | `backend/src/main/resources/db/migration` |
| Spring Kafka | 4 | Producers/consumers, `DefaultErrorHandler` with exponential back-off, `-dlt` topics | `com.cipherchat.shared.kafka`, consumers |
| Lettuce (Spring Data Redis) | via Boot | Rate limits, sequence counters, dedup cache, presence, pub/sub fan-out | `com.cipherchat.shared.redis`, gateway |
| Resilience4j | 2.x | Circuit breaker + retry on outbound LLM calls | `com.cipherchat.ai` |
| Micrometer + Prometheus | via Boot | `/actuator/prometheus`, custom send-latency and session gauges | `MetricsConfig` |
| springdoc-openapi | 2.x | Live OpenAPI at `/swagger-ui.html`, `docs/API.md` derived from it | controllers |
| jjwt | 0.12 | HS256 access tokens (key-pinned) | `JwtService` |
| BCrypt (Spring Security crypto) | strength 12 | Password hashing | `PasswordConfig` |
| AWS SDK v2 (S3) | 2.x | Attachment storage driver (`STORAGE_DRIVER=s3`), presigned URLs | `com.cipherchat.upload` |
| Java `java.net.http` via `RestClient` | JDK | LLM client (chat-completions protocol, vendor-neutral) | `LlmClient` |
| Maven Wrapper | 3.9 | Reproducible builds; Spotless, JaCoCo, Surefire/Failsafe | `backend/mvnw`, `pom.xml` |

### Test stack

| Technology | Role |
|---|---|
| JUnit 5, AssertJ, Mockito | Unit tests |
| Spring Boot Test + `@ServiceConnection` | Wires containers into the context without property plumbing |
| Testcontainers 2 (Postgres 17, Redis 7, Kafka native) | Integration suites against real infrastructure |
| Spring Modulith test | Module-boundary verification |
| JaCoCo | Merged unit + IT coverage, gate at 60 % lines |
| Spotless (Eclipse formatter) | Formatting and unused-import gate |

## Data and messaging

| Technology | Version | Role |
|---|---|---|
| PostgreSQL | 17 | Source of truth; unique indexes enforce exactly-once and E2EE replay rules; expression index for full-text search |
| Redis | 7 | Coordination only, never authoritative; fails open (dedup) or closed (sequence) by policy |
| Apache Kafka (KRaft) | 3.8 / 4.x native image | Everything after a message is stored: notifications, audit, analytics; outbox → topics → idempotent consumers → DLT |
| MinIO (local) / S3 (cloud) | — | Attachment object storage |

## Frontend (thin client)

| Technology | Version | Role |
|---|---|---|
| React | 19 | UI |
| TypeScript | 5 | Language |
| Vite | 6 | Build, dev server |
| `@stomp/stompjs` | 7 | STOMP over WebSocket, behind a Socket.IO-shaped adapter (`stompSocket.ts`) |
| Axios | 1.20 | REST client with refresh-cookie handling |
| React Router | 6.30 | Routing |
| Framer Motion, Tailwind | — | Motion and styling |
| Web Crypto API | browser | AES-256-GCM, X3DH-style key agreement, Ed25519 prekey signatures (E2EE lives in the client) |
| Vitest, Testing Library, ESLint | — | 153 unit tests, lint, typecheck |
| nginx | 1.27-alpine | Serves the built bundle, `/healthz` |

## Delivery

| Technology | Role | Where |
|---|---|---|
| Docker (multi-stage, layered jar, non-root) | Backend and frontend images | `backend/Dockerfile`, `chat-front/Dockerfile` |
| Docker Compose | Single-host stack; `docker-compose.scale.yml` adds nginx `least_conn` and two replicas | root |
| GitHub Actions | CI (tests, SCA, IaC validation, image build/scan/push), Release (versioned jar, semver images, SBOMs, GitHub Release), Deploy (Render hooks, EKS via OIDC), CodeQL, Dependabot | `.github/` |
| GitHub Container Registry | Image registry (`ghcr.io/<owner>/cipherchat-*`) | workflows |
| Trivy | Dependency, image and secret scanning; CycloneDX SBOMs | workflows, `scripts/verify-all.sh` |
| CodeQL | Static analysis, Java and TypeScript, security-extended queries | `codeql.yml` |
| Render | Hosted demo: Docker web services, managed Postgres and Key Value, blueprint in `render.yaml` | root |
| Kubernetes (kustomize) | Production shape: Deployments, HPA, PDB, probes, Ingress, IRSA | `infrastructure/kubernetes` |
| Terraform | AWS: VPC, EKS, RDS Postgres, ElastiCache, MSK, S3, IAM/OIDC | `infrastructure/terraform` |
| k6 | Load harness: REST latency, STOMP send → ACK → broadcast | `load/k6-stomp.js` |
| Python 3 (stdlib + `websocket-client`) | Stack and fan-out verifiers used by `scripts/verify-all.sh` | `scripts/` |

## Documentation

`docs/ARCHITECTURE.md`, `SYSTEM_DESIGN.md`, `API.md`, `DATABASE_DESIGN.md`, `KAFKA_DESIGN.md`, `SECURITY.md`, `SCALABILITY.md`, `DEPLOYMENT.md`, `LOCAL_DEVELOPMENT.md`, ten ADRs under `docs/adr/`, `INTERVIEW.md` and `INTERVIEW-REVIEW.md`. The README's *Verification status* table states, per claim, whether it was executed, designed, or still needs infrastructure the repository does not own.
