# Deployment

Three targets, one artifact: the backend container image built by `backend/Dockerfile` (multi-stage, layered jar, JRE-only, non-root) and the frontend image built by `chat-front/Dockerfile` (nginx static). Configuration is environment variables only; nothing is baked into images except the frontend's API origin (`VITE_API_URL`).

## 1. Render (the current hosted demo)

### What was failing, and why

The previous deploys were a **Node** service configured in the Render dashboard (root directory, build and start commands typed by hand, no `render.yaml`). Two things drifted underneath that configuration:

1. **Repository layout changed** — the backend moved to `chat-back/src` with a TypeScript build step, while the dashboard still ran the pre-TypeScript commands against the old root. Render then either could not find the entry point or ran `node server.js` against a tree that needed `npm run build` first.
2. **Runtime floor changed** — `otplib` → `@noble/hashes` requires Node ≥ 20.19, and Vite 8/rolldown ≥ 20.19/22.12; the dashboard's Node version was older. Locally this was masked by nvm.

Both are the same root cause: **deploy configuration living outside the repository**, so a correct commit could not carry the change that made it deployable. (The exact failing log line was never captured — the Render email only linked to the dashboard — so treat the second point as the most likely proximate error and the first as the structural one.)

### The fix

- `render.yaml` at the repository root makes the service a **Docker** runtime built from `backend/Dockerfile`. The image pins Java 21; the build no longer depends on Render's Node toolchain at all.
- Health check `/actuator/health/readiness`; port from `PORT`.
- Managed Postgres and Redis (Render Key Value) are declared in the same blueprint and injected via `fromDatabase` / `fromService` — no hand-typed connection strings.
- **Kafka is not offered by Render.** The blueprint points `KAFKA_BOOTSTRAP_SERVERS` at an external broker (Upstash/Confluent/Redpanda Cloud) supplied as a secret. The app boots and passes readiness without a reachable broker (publications queue in the outbox table; `/actuator/health` shows the `kafka` contributor DOWN until it is configured) — set the variable before expecting notifications/audit rows.
- Uploads: Render disks are single-instance; use `STORAGE_DRIVER=s3` with any S3-compatible bucket for anything beyond a demo.

Deploy: connect the repo, choose "Blueprint", set the secret env vars the blueprint marks `sync: false`, deploy. Every later change to build/start/health/env is a commit, reviewable and revertible.

### What running the exact image locally found

The blueprint's image was built with `--no-cache` from the same Dockerfile and context Render uses and then started under Compose. It **built and then failed to start**: Spring Boot 4's `tools` jarmode writes the layered layout without the launcher classes unless `extract --layers --launcher` is used, so the `JarLauncher` entrypoint did not exist. That is a deploy-blocking defect the static review of the blueprint could not have caught; it is fixed in the Dockerfile and the container now passes its readiness check. Two caveats remain that only the platform can confirm: the hosted deploy itself has not been observed (no Render account/logs were available), and the persistent disk Render mounts at `/data/uploads` is owned by root while the container runs as an unprivileged user — if uploads fail with a permission error there, set `STORAGE_DRIVER=s3` (recommended for anything beyond a demo anyway) or run a one-off `chown` on the disk.

## 2. Docker Compose (single host, staging, demos)

`docker-compose.yml` is the complete stack with health-gated startup; `docker-compose.scale.yml` adds nginx `least_conn` and replicas. See `LOCAL_DEVELOPMENT.md`. For a real host: set `JWT_SECRET`, `SEAL_SECRET`, `DATABASE_PASSWORD`, `CORS_ALLOWED_ORIGINS`, `PUBLIC_BASE_URL`, `COOKIE_SECURE=true`, terminate TLS in front (Caddy/Traefik/nginx), and keep the Postgres volume on durable storage with a backup job.

## 3. AWS (Kubernetes) — the production shape

```
Route53 ─▶ ALB (ACM TLS, idle 3600s for WS) ─▶ EKS
                                                ├─ cipherchat-frontend (nginx, 2×)
                                                └─ cipherchat-backend  (2–10×, HPA)
                                                      ├─ RDS PostgreSQL 17 (Multi-AZ)
                                                      ├─ ElastiCache Redis 7 (Multi-AZ)
                                                      ├─ MSK Kafka (3 brokers, RF 3)
                                                      └─ S3 uploads (+ CloudFront)
```

### Provision — `infrastructure/terraform`

```bash
cd infrastructure/terraform
terraform init
terraform apply -var-file=environments/dev.tfvars     # or prod.tfvars
terraform output -json > ../kubernetes/tf-outputs.json
```

Creates VPC (3 AZ, private/public/database subnets), EKS with IRSA, RDS (encrypted, master password in Secrets Manager, `max_connections=400`), ElastiCache (TLS, failover in prod), MSK (RF 3, `min.insync.replicas=2`, JMX/Node exporters), the uploads bucket (private, SSE, CORS for presigned PUT), the backend IRSA role scoped to `uploads/*`, and the JWT/SEAL secrets.

### Deploy — `infrastructure/kubernetes`

1. Fill `configmap.yaml` from the Terraform outputs (`DATABASE_URL`, `REDIS_URL`, `KAFKA_BOOTSTRAP_SERVERS`, `S3_BUCKET`, IRSA role ARN on the ServiceAccount, ACM certificate ARN on the Ingress).
2. Secrets: install External Secrets Operator and point it at the two Secrets Manager entries (app secret, RDS master), or create `cipherchat-backend-secrets` by hand for a dev cluster (template in `secret.yaml`).
3. `kubectl apply -k infrastructure/kubernetes`.

What the manifests encode and why:

| Setting | Reason |
|---|---|
| `maxUnavailable: 0`, `maxSurge: 1` | never drop below capacity during a rollout |
| `terminationGracePeriodSeconds: 45` + `preStop sleep 5` | ALB stops routing before SIGTERM; Spring's graceful shutdown (30 s) drains in-flight requests |
| startup / liveness / readiness probes on Actuator | readiness includes DB and Redis — a pod that lost either stops taking traffic; Kafka is reported in `/actuator/health` but does not gate readiness (sends work through a broker outage via the outbox) |
| no CPU limit, memory limit 1 Gi, `MaxRAMPercentage=75` | avoid CFS throttling on latency-sensitive WS traffic; JVM sized to the cgroup |
| `readOnlyRootFilesystem`, non-root, drop ALL caps | least privilege |
| PDB `minAvailable: 1`, zone spread | survive node drains and AZ loss |
| HPA 2–10 on CPU 65 % (WS-sessions metric documented) | connection-bound service |
| ALB `idle_timeout 3600`, target-type `ip` | long-lived WebSockets |

### CI/CD — `.github/workflows/ci.yml`

`backend` (Spotless → unit → Testcontainers ITs → JaCoCo gate) and `frontend` (lint → typecheck → test → build) run on every push/PR; `sca` scans lockfiles (Trivy, fails on CRITICAL/HIGH fixable); `images` builds both containers, scans them, and pushes to GHCR on the default branch; `deploy` (environment `production`, manual approval) assumes an AWS role via OIDC, `kustomize edit set image` to the commit SHA, applies, and waits for the rollout.

## Operations checklist

- **Backups**: RDS automated (14 days prod) + a weekly logical dump to S3 for cross-account safety. Redis needs none (reconstructible). Kafka retention 7 days; the outbox table is the replay source of truth.
- **Rotation**: `JWT_SECRET` rotation logs everyone out at once (acceptable, announced); `SEAL_SECRET` rotation requires re-sealing `two_factor.secret_sealed` — script before rotating.
- **Scaling knobs**: replicas (HPA), `DB_POOL_SIZE` (keep × replicas < `max_connections`), `KAFKA_PARTITIONS` (only up, and only with a topic migration), RDS instance class.
- **Dashboards**: Prometheus scrape annotations are on the pods; key series `cipherchat_send_latency_seconds{quantile}`, `cipherchat_ws_sessions`, `cipherchat_send_duplicates_total`, `kafka_consumer_records_lag_max`, `hikaricp_connections_pending`.
- **DLT watch**: alert on any message in `*-dlt`; replay after the fix (idempotency ledger makes it safe).
