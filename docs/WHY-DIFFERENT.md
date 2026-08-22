# Why This System Is Different

## The problem

Small organizations that handle sensitive conversations — legal clinics,
healthcare practices, journalism and NGO teams — cannot put those
conversations in a third-party SaaS. Vendor breach, vendor subpoena, vendor
employee: every one of them reads the org's most private communication.
Self-hosting solves *custody* but not *trust in your own operator*, and
self-hosted deployments are exactly where nodes die, disks fill, and nobody
is on call.

CipherChat is a self-hostable team messenger built around the four
requirements that actually follow from "self-hosted + sensitive":

| Requirement | What this system does about it |
|---|---|
| **Provable delivery** | At-least-once transport with exactly-once persistence: client-UUID dedup, per-room sequence numbers, ACK/retry with backoff, offline IndexedDB queue, DB unique-index backstops. Demonstrated by killing a pod mid-conversation. |
| **Operator-proof privacy** | E2EE DMs (X3DH-lite + per-direction HMAC chains + AES-256-GCM), self-implemented and pinned to RFC/NIST test vectors, with safety numbers, recovery codes, and an honest threat model. Even the DB admin reads only ciphertext. |
| **Failure survival** | Horizontal scale-out on Redis-backed coordination, sticky-session LB, graceful shutdown, seeded sequence counters — a rolling deploy or a killed pod loses zero messages. |
| **Content-free observability** | Operators get p50/p95/p99 latency, delivery rates, and concurrency (Prometheus + in-app dashboard) without any metric that could reveal message content. |

## What it deliberately is NOT

- **Not a Slack clone with encryption sprinkled on.** The split is explicit
  and architectural: DMs are E2EE (no server AI, by construction); rooms are
  server-readable team spaces (AI summaries, server-side search, TTL
  self-destruct). Two privacy tiers, honestly labeled — see ADR-0004.
- **Not a demo of technologies.** Every component traces
  problem → requirement → decision → trade-off in `docs/adr/`. Redis exists
  because in-memory dedup double-persists across replicas, not because it
  looks good on a README.
- **Not "webscale."** The scale assumptions below are defensible for the
  target customer, and the parts that would change at 100× are named.

## Scale assumptions (and what they drove)

Single-org deployments:

| Assumption | Value | What it drove |
|---|---|---|
| Users per org | 50 – 5,000 | Membership arrays on room docs (not a join collection); per-room unread counts as indexed range-counts |
| Concurrent sockets per pod | ≤ 500 | 2–4 pods behind nginx `ip_hash`; per-user rooms for cross-pod targeting |
| Peak message rate | ~200 msg/s org-wide | Lua token bucket (20 burst / 2 s refill per user); k6 threshold p95 < 250 ms at 100 msg/s on 2 pods |
| History growth | ~10 M messages/yr, tens of GB | Cursor pagination on `_id` (offset/skip degraded linearly); `{chatroom, sequenceNumber}` and `{chatroom, createdAt}` indexes |
| Redis working set | < 1 GB | Single Redis node; Cluster/Sentinel named as the growth path |

**What changes at 100× (and is deliberately out of scope):** Kafka in front
of persistence, room sharding, a presence service split out of the message
path, S3-backed media, read replicas. Each is listed in the scaling section
of the architecture doc with the trigger that would justify it.

## The engineering signals an interviewer can check

1. Delivery pipeline with five independent layers, each *tested* — including
   an integration test that double-sends the same UUID and asserts one row.
2. A crypto implementation pinned to RFC 7748 / RFC 8032 / RFC 5869 / NIST
   GCM vectors, with tamper, replay, out-of-order, and rotation tests.
3. A kill-a-pod demo script (`docker-compose.scale.yml`) where the surviving
   replica carries the conversation without a lost message.
4. 190+ automated tests across unit / integration / crypto KAT layers, CI
   with a real Redis service container, k6 load script with thresholds.
5. ADRs where every major choice names the alternative it rejected and the
   cost it accepted.
