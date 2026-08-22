# ADR-0006: Content-free observability — prom-client + in-app JSON dashboard

**Status:** Accepted (Phase 2)

## Problem
The original metrics module was a per-process singleton served from one
unauthenticated JSON endpoint: with N replicas behind a load balancer it
returned whichever pod the LB picked (one shard of the truth), sorted a 10k
latency array on every request, and could never be aggregated historically.
Separately: an E2EE product must let operators see system health without
ever seeing message content.

## Requirement
Operators need p50/p95/p99 message latency, delivery rate, and connection
counts across all replicas over time — with a hard guarantee that no metric
ever carries message content or per-user behavioral detail.

## Decision
- **prom-client `/metrics`** per pod: default process metrics + a latency
  histogram (`cipherchat_message_latency_ms`, buckets 5→2500ms), an outcome
  counter (`sent|failed|duplicate|rate_limited`), and a connected-sockets
  gauge. Prometheus scrapes every pod and aggregates; per-process counters
  are a feature, not a bug.
- **In-app JSON dashboard** (`/analytics/metrics` + a metrics page in the
  UI) stays — it makes the reliability layer *visible in a demo* without
  standing up Prometheus/Grafana. Latency percentiles there use a ring
  buffer, not an O(n) shift-and-sort.
- **Content-free rule:** metric names and labels are reviewed against one
  test — could this line reveal what someone said, or to whom? Counts,
  latencies, and outcomes only; no user ids, no room ids, no text.

## Trade-off
- Two metric surfaces (Prometheus + JSON) with slightly different windows;
  they share the same instrumentation points so they can't diverge on the
  facts, only on presentation.
- `/metrics` is unauthenticated by convention (scrape targets live on the
  private network); the deploy docs pin it behind the LB. In-app JSON stays
  JWT-gated.
