# Scalability

## Target envelope

CipherChat is self-hosted team messaging for one organisation at a time. The design targets, and the numbers every sizing decision below is derived from:

| Dimension | Target |
|---|---|
| Users per deployment | 50 – 5,000 |
| Concurrent WebSocket sessions | up to 10,000 (design target; the 10,000/10,000 figure was measured on the previous Node implementation — see `WHY-DIFFERENT.md`, not re-measured on this backend) |
| Sessions per backend pod | ~2,000 comfortable, 5,000 ceiling |
| Peak message rate, org-wide | ~200 msg/s sustained, 1,000 msg/s bursts |
| Messages per year | ~10 M (tens of GB in Postgres with attachments external) |
| p95 end-to-end broadcast (send → other client's screen) | < 250 ms at 100 msg/s on 2 pods (target, not measured on this backend) |

Anything beyond this is a different product (multi-tenant SaaS), and the trade-offs would be different.

## The stateless-replica rule

Every backend pod is interchangeable. There is no state on a pod that another pod would need:

| Concern | Where it lives | Why not in the JVM |
|---|---|---|
| Who is online | Redis hash `online:<userId>` (TTL 90 s) + index set | a user's sessions may be on different pods |
| Rate-limit buckets | Redis Lua token bucket | limits must hold across pods |
| Per-room sequence counter | Redis `INCR seq:<room>` seeded from `max(sequence_number)` | two pods must never hand out the same slot |
| Client-id dedup | Redis `SET NX` (10 min) + unique index | retry may land on a different pod |
| Typing indicators | Redis TTL keys | expiry must fire even if the origin pod died |
| WebSocket sessions | the pod that accepted the TCP connection | unavoidable; everything *about* the session is elsewhere |

A WebSocket is the one sticky thing, and it is sticky by nature of TCP, not by load-balancer configuration. That is why the LB runs `least_conn` with **no session affinity**: HTTP requests may hit any pod (auth is a stateless JWT), and a reconnecting socket may land anywhere.

## Fan-out across pods

```
 pod A ─ SEND ─▶ Postgres (commit) ─▶ Spring event ─▶ Redis PUBLISH ws:room:<id>
                                                             │
                 ┌───────────────────────────────────────────┼──────────────┐
                 ▼                                           ▼              ▼
             pod A subscribers                          pod B subs       pod C subs
```

Each pod subscribes to `ws:*` on Redis and forwards frames to its own STOMP broker's `/topic/rooms/<id>` etc. Cost per message is one Redis publish plus one local delivery per subscribed session; Redis pub/sub at these rates (hundreds of msg/s, kilobyte frames) is a rounding error on a single small node.

Delivery order to a client is preserved because a room's events all originate from a serialised sequence and each pod processes the Redis subscription on one thread per connection.

## What scales how

### Horizontal (add pods)

- **Connections and CPU** — the HPA (`infrastructure/kubernetes/backend-hpa.yaml`) scales on CPU 65 % by default, with a commented alternative on `cipherchat_ws_sessions` (2,000 per pod) via the Prometheus adapter, which is the better signal for a connection-bound service.
- **Kafka consumers** — consumer groups rebalance automatically; parallelism ceiling = partitions (12 in prod).
- **Rolling deploys without message loss** — `maxUnavailable: 0`, `terminationGracePeriodSeconds: 45` > `server.shutdown` timeout, a `preStop` sleep so the LB stops routing before SIGTERM, and clients whose socket closes reconnect to a surviving pod and drain their IndexedDB offline queue (idempotent on `clientMessageId`).

### Vertical / managed (grow the dependency)

- **PostgreSQL** is the write bottleneck and the one component that does not shard. At 200 msg/s it is idle; at 10× the envelope it is still a single `db.r6g.large`. Read replicas would take history/search reads if ever needed; nothing in the schema prevents it.
- **Redis** working set is tiny (presence + counters + buckets, well under 1 GB). ElastiCache Multi-AZ for failover, not for capacity.
- **Kafka** MSK 3 brokers is far more than the event rate needs; it is sized for durability (RF 3, `min.insync.replicas=2`), not throughput.

### Per-request budget

Virtual threads (`spring.threads.virtual.enabled`) make blocking JDBC/Redis calls cheap to hold, so the request path is limited by the HikariCP pool (`DB_POOL_SIZE` × pods < `max_connections`) rather than by thread counts. The send pipeline does: 1 auth lookup (cached principal in the JWT), 1 Redis Lua call, 1 Redis GET, 1 Redis INCR, 1 DB transaction (insert message + upsert watermark + insert outbox row), 1 Redis publish. No N+1 anywhere on hot paths; sidebar and history endpoints batch-load users and use single-query aggregates.

## Backpressure and protection

- Token bucket per user (20 burst, 2/s refill) at the API and STOMP layer, shared across pods.
- STOMP message size limits (64 KB inbound) and a bounded send buffer per session; a slow consumer is disconnected rather than allowed to grow the heap.
- Presence roster broadcast is throttled (leading + trailing edge, 1 s) and bounded (first 100 users + total) — a burst of 500 connects is two broadcasts, not 500 × N frames.
- Kafka consumers: retries with back-off then DLT; a poison record never blocks a partition.
- LLM calls sit behind a circuit breaker; an LLM outage degrades three endpoints to fast 503s and holds no threads.

## Known limits (honest list)

- Redis pub/sub is fire-and-forget: if a pod is partitioned from Redis for a moment, live frames during that window are lost for *its* sessions. Clients recover on reconnect by fetching history since their last sequence; durability is Postgres + Kafka, never pub/sub.
- Presence is eventually consistent within the 90 s TTL if a pod dies without sending disconnects.
- The in-app metrics dashboard shows one pod's numbers; cluster-wide views are Prometheus/Grafana.
- No sharding story for Postgres beyond read replicas — deliberately, given the envelope.

## Benchmark record

Previous (Node) implementation, single node: 10,000/10,000 concurrent WebSocket connections held with heartbeat, roster broadcaster fix required to get there (the naive per-connect broadcast was O(N²)). The Java gateway keeps the same throttled roster design but that number has **not** been re-measured against it. The Java backend's own harness is `load/k6-stomp.js` (REST latency + STOMP send → ACK → broadcast); its results, and only its results, are quoted in the README's *Verification status* section.
