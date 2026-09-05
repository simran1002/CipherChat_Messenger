# Benchmarks — the Java gateway, measured

Measured 2026-09-05/06 on one laptop: Windows 11, 12 CPUs, Docker Desktop (WSL 2) with an 8 GB / 12 vCPU VM running the whole Compose stack (backend, PostgreSQL 17, Redis 7, Kafka native) **and** the load generators. One backend pod, no memory limit on the container, JVM `MaxRAMPercentage=75`, ZGC, HikariCP pool of 20, Kafka `acks=all`. Every number below is from that machine; none is extrapolated.

The load generators live in the repository: `load/k6-stomp.js` (REST + STOMP send → ACK → broadcast latency at a fixed message rate) and `load/connflood.py` (connection density: N raw-WebSocket STOMP sockets over M users, connect latency, broadcast latency and completeness to every socket, server gauges).

## 1. Steady-state messaging on one pod

k6, 30 chat VUs in 5 public rooms (each sends 20 messages 250–500 ms apart, reconnecting between iterations) plus 5 REST VUs, 60 s. Best run after the fixes below (`k6-stomp.js`, run 11):

| Metric | p50 | p95 | max |
|---|---|---|---|
| STOMP send → ACK | 23 ms | 54 ms | 0.9 s |
| STOMP send → broadcast received by another subscriber | 27 ms | 64 ms | 0.9 s |
| WebSocket connect (handshake) | 9 ms | 45 ms | — |
| REST (`GET /chatrooms`, `GET /users/me`) in steady state | 34 ms | — | — |

Throughput during the run: 43 messages/s sustained, 2,940 of 2,940 sends acknowledged, 0 duplicates persisted (every retry answered `duplicate: true`). Server-side send latency (Redis dedup + `INCR` + PostgreSQL insert under two unique indexes + outbox rows + commit) averaged 83–130 ms; the commit itself waits on WAL fsync inside the VM (`COMMIT` p50 186 ms, max 820 ms when Postgres logs statements over 100 ms), which is the floor on this disk.

**What still fails in this profile, and why it is not steady state.** The run starts with 35 accounts registering at once. BCrypt-12 costs ~250 ms of CPU each, so on a shared 12-vCPU VM the sign-up storm saturates the 20-connection pool for roughly seconds 5–15 of every run: REST p95 5–6 s for that window and 5–8 % of requests failing with `503 dependency_unavailable`. After the window, REST is back to tens of milliseconds. Sizing note: a sign-up storm needs a separate, smaller pool or a queue in front of the hasher; the message path is unaffected once the burst drains.

## 2. Connection density on one pod

`connflood.py`, run **inside the Compose network** (Docker Desktop's host port proxy collapses at a few hundred concurrent handshakes and is not part of the system under test), 100 users, one public room, 50 new sockets per second, real client heartbeat (10 s), 60 s hold, 20 broadcasts to every socket during the hold.

| Metric | Result |
|---|---|
| Sockets requested / connected | 5,000 / 5,000, 0 failures, 0 dropped during the hold |
| Time to open all 5,000 | 105 s (ramp-limited at 50/s) |
| Connect latency (handshake + STOMP `CONNECT` → `CONNECTED`) | p50 610 ms, p95 1.85 s, max 2.8 s during the ramp |
| JVM heap | 1.09 GB before → 1.56 GB with 5,000 sockets held (≈ 97 KB per socket, buffers included) |
| Backend CPU during the ramp | 38 % of the VM |
| Broadcast to all 5,000 subscribers of one room | 100,000 of 100,000 deliveries (20 messages × 5,000 sockets) |
| Broadcast latency at 5,000 subscribers per room | p50 1.0 s, p95 6.6 s, max 8.3 s |

Read the last row carefully: it is the honest cost of a *single 5,000-member room* on the in-memory simple broker, which delivers one frame per subscriber serially (about 1.3 ms per socket). Five rooms of 1,000 would not show it. It is also the concrete reason the design notes say large rooms need sharded delivery or a broker relay.

**10,000 sockets was attempted twice and did not complete.** Through the host port proxy, 508 connected before the proxy stopped forwarding. Inside the network at 250 connects/s, 1,311 connected before the VM stalled (pool timeouts appeared with all 20 connections *idle*, i.e. the VM itself, not the gateway, stopped responding). At 50 connects/s the gateway opened and held 5,000 without a single failure while the VM stayed responsive, so the limit found here is the shared VM under a connect storm, not a gateway limit. The earlier Node implementation's 10,000-socket figure was measured on a different implementation and stays labelled as such.

## 3. What the measurement found and fixed

Each of these was invisible to the unit and integration suites and visible only under load, with the evidence that located it:

1. **Password hashing inside a transaction** (`AuthService`, `UserService` class-level `@Transactional`): every registration and login pinned a pooled connection for the whole BCrypt hash. Evidence: pool acquire waits of 3.7 s with `active=20, waiting=35` during sign-ups. Fix: hash and verify with `NOT_SUPPORTED`, one short transaction for the audit event and session row.
2. **Socket fan-out behind the database queue** (`DomainEventFanout`): the eight listeners used `@ApplicationModuleListener`'s default `REQUIRES_NEW`, so every Redis publish first waited for one of 20 connections it never used for a write. Evidence: thread dump plus `pg_stat_activity` (the send handler averaged 130–180 ms while clients saw ACK p95 3 s and broadcast p95 6–10 s). Fix: `propagation = NOT_SUPPORTED`. Broadcast p95 went from 6–10 s to 64 ms.
3. **Unbounded, then caller-blocking, event executor**: with virtual threads on, Boot's `@Async` executor is unbounded, so an event burst spawned one listener per event and stampeded the pool; a first fix (a concurrency-limited `SimpleAsyncTaskExecutor`) blocked the committing thread inside AFTER_COMMIT while it still held its connection. Evidence: Hikari `active=20, pending=40` with all Postgres sessions idle, and Hikari leak traces pointing at `MessagePersistence.persist`. Fix: a queue-backed `ThreadPoolTaskExecutor` (`cipherchat.events.concurrency`, `queue-capacity`).
4. **Fan-out sharing an executor with Kafka externalization**: Kafka sends in the VM stalled for up to 10 s at times; stuck externalizations filled the shared workers and broadcasts queued behind them. Fix: a dedicated `fanoutExecutor` for the fan-out listeners (`AsyncConfig.FANOUT_EXECUTOR`). Implemented and unit-tested; its effect on tail latency was not re-measured because Docker Desktop failed during the rebuild.
5. **Per-connection presence cost**: each STOMP session performs one user read (roster entry) and, on a user's first session, one write plus an outbox event. Fine at 50 connects/s; part of why a 250/s storm from inside the same VM saturated everything. Not changed; recorded as the next thing to cache.

## 4. Environment caveats that a reader must apply

- The load generators, the gateway and all three data stores shared one 8 GB / 12 vCPU VM. Kafka's broker periodically spiked to 200 % CPU inside it; Postgres commits fsync onto a virtual disk. Absolute latencies are pessimistic; the *relative* findings (which component queues behind which) are what transfer.
- Docker Desktop's port-forwarding proxy adds latency and fails under a few hundred concurrent handshakes. Only the in-network runs (`--network cipherchat_default`, target `backend:8080`) are free of it; the run-11 k6 numbers went through it and are, if anything, worse than the gateway alone.
- One pod. The cross-replica fan-out path (Redis pub/sub between pods, `docker-compose.scale.yml`, `scripts/verify-fanout.py`) and the Redis/Kafka failure drills (`scripts/verify-stack.py --chaos`) were not run in this pass.

## 5. Reproduce

```bash
docker compose up -d --build backend                       # stack
python scripts/verify-stack.py                               # 19 contract checks (passed 19/19 in this pass)
docker run --rm -i --network cipherchat_default -e BASE_URL=http://backend:8080 \
  -e VUS=30 -e ROOMS=5 -e MSGS_PER_VU=20 -e DURATION=60s grafana/k6 run - < load/k6-stomp.js
docker build -t cipherchat-loadgen -f - . <<'EOF'
FROM python:3.12-slim
RUN pip install --no-cache-dir "websockets>=13" "httpx>=0.27"
WORKDIR /load
ENTRYPOINT ["python"]
EOF
docker run --rm --network cipherchat_default -v "$PWD/load:/load" cipherchat-loadgen connflood.py \
  --base http://backend:8080 --sockets 5000 --users 100 --ramp 50 --hold 60 --broadcasts 20
```
