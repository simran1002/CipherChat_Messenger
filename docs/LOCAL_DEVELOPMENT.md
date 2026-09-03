# Local Development

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Docker Desktop (or compatible) | current | Postgres, Redis, Kafka, MinIO; also required by the integration tests |
| JDK | 21 | Temurin recommended; the Maven wrapper is committed, no Maven install needed |
| Node | 22+ | frontend only (`chat-front`) |

No global secrets are needed for local work — `application.yaml` ships obviously-fake defaults that the `prod` profile refuses.

## Option A — everything in Docker

```bash
docker compose up --build
```

- Frontend: http://localhost:3000
- API + Swagger UI: http://localhost:8080/swagger-ui.html
- Health: http://localhost:8080/actuator/health
- Kafka from host tools: `localhost:29092`

Add MinIO-backed uploads (switches the backend to the S3 driver):

```bash
STORAGE_DRIVER=s3 S3_ENDPOINT=http://minio:9000 S3_PUBLIC_BASE_URL=http://localhost:9000/cipherchat-uploads docker compose --profile s3 up --build
```

Scale-out demo (nginx `least_conn` → 2 replicas):

```bash
docker compose -f docker-compose.yml -f docker-compose.scale.yml up --build --scale backend=2
```

Then open two browsers, chat, and `docker compose kill cipherchat-backend-1` — both clients reconnect to the survivor; anything typed while disconnected drains from the offline queue.

## Option B — backend from the IDE, dependencies in Docker

```bash
docker compose up postgres redis kafka        # dependencies only
cd backend
./mvnw spring-boot:run                        # or run CipherchatApplication from the IDE
```

The default `application.yaml` points at `localhost:5432/6379/9092`. Flyway applies the schema on first start; the Kafka topics are created by `KafkaAdmin` at boot.

Frontend against it:

```bash
cd chat-front
npm ci
npm run dev                                   # http://localhost:3000, proxies /api, /ws, /uploads to :8080
```

`VITE_DEV_API_TARGET` overrides the proxy target; `VITE_PORT` the dev port.

## Tests

```bash
cd backend
./mvnw test                                   # unit + Modulith boundary tests (no Docker needed)
./mvnw verify                                 # + integration tests via Testcontainers (Docker required; they skip without it)
./mvnw spotless:apply                         # fix formatting/import order
```

Integration tests (`*IT`) start disposable Postgres/Redis/Kafka containers and exercise the real HTTP and STOMP contracts. Coverage report: `target/site/jacoco/index.html` (gate: 60 % lines, raised as the suite grows). Modulith also writes C4/PlantUML module diagrams to `target/spring-modulith-docs/` during the test run.

Frontend:

```bash
cd chat-front
npm run typecheck && npm run lint && npm test && npm run build
```

One command for the whole runtime verification (builds from an empty cache, starts the stack, runs every check below, the k6 load test, the two-replica fan-out and kill-a-replica drill, and the image scan; writes `docs/VERIFICATION-RUN.md`):

```bash
bash scripts/verify-all.sh
```

Individually, against a running stack (`docker compose up`):

```bash
python scripts/verify-stack.py            # health, auth, exactly-once send, private-room 403s, DM replay 409, Kafka notification
python scripts/verify-stack.py --chaos    # + pauses Redis and stops Kafka to check the documented degradation and recovery
python scripts/verify-fanout.py           # scale-out profile: two sockets on different replicas, ACK + cross-replica broadcast
docker run --rm -i -e BASE_URL=http://host.docker.internal:8080 grafana/k6 run - < load/k6-stomp.js   # latency/throughput
```

## Useful endpoints

| | |
|---|---|
| OpenAPI JSON | `GET /v3/api-docs` |
| Swagger UI | `/swagger-ui.html` |
| Health (liveness / readiness) | `/actuator/health/liveness`, `/actuator/health/readiness` |
| Prometheus | `/actuator/prometheus` |
| Modulith module graph (actuator) | `/actuator/modulith` |
| In-app metrics JSON | `GET /api/v1/analytics/metrics` (authenticated) |

## Environment variables (backend)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 8080 | HTTP port |
| `DATABASE_URL` / `DATABASE_USER` / `DATABASE_PASSWORD` | local Postgres | JDBC |
| `DB_POOL_SIZE` | 20 | HikariCP pool — × replicas must stay under `max_connections` |
| `REDIS_URL` | `redis://localhost:6379` | |
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | |
| `KAFKA_PARTITIONS` / `KAFKA_CONSUMER_CONCURRENCY` | 6 / 3 | topic layout, listener threads |
| `JWT_SECRET` / `SEAL_SECRET` | dev placeholders | ≥ 32 bytes; refused in `prod` if left at default |
| `COOKIE_SECURE` | false | true behind TLS |
| `CORS_ALLOWED_ORIGINS` | localhost dev origins | comma-separated |
| `STORAGE_DRIVER` | local | `local` \| `s3` |
| `UPLOAD_DIR` / `PUBLIC_BASE_URL` | `./data/uploads` / `http://localhost:8080` | local driver |
| `S3_BUCKET` / `AWS_REGION` / `S3_ENDPOINT` / `S3_PUBLIC_BASE_URL` | — | s3 driver (credentials from the AWS default chain) |
| `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` | — | AI features via any chat-completions endpoint (Ollama, vLLM, hosted); base URL or model absent → endpoints answer `503 ai_not_configured` |
| `LOG_FORMAT` | plain | `ecs` for JSON logs |
| `LOG_LEVEL` | INFO | `com.cipherchat` logger |
| `SPRING_PROFILES_ACTIVE` | — | `prod` tightens secrets/cookies |

## Troubleshooting

- **`Could not find a valid Docker environment`** during `mvnw verify` — Docker is not running; unit tests still pass, ITs are skipped only when using `test`, so either start Docker or run `./mvnw test`.
- **`FATAL: invalid value for parameter "TimeZone"`** on the first connection — the JDBC driver sends the JVM's default zone and the Alpine Postgres image lacks legacy aliases such as `Asia/Calcutta`. The application pins itself to UTC (`CipherchatApplication.main`, the Dockerfile and the test runners all set `-Duser.timezone=UTC`); if you run the class some other way, pass that flag.
- **Flyway validate failed / schema mismatch** — the entity and migration disagree; fix the migration (never `ddl-auto: update`).
- **Kafka topics missing** — check `KAFKA_BOOTSTRAP_SERVERS`; topics are created by the app on boot, not by the broker's auto-create.
- **STOMP connects then disconnects** — the token in the `CONNECT` header is expired/invalid; the frontend refreshes and reconnects automatically (`connect_error: Invalid token`).
