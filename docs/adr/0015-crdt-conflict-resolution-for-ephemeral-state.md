# ADR-0015: CRDT merge algorithms for ephemeral state, scoped to what this repository can actually prove

**Status:** Accepted, narrowly. This is a conflict-resolution library, not a multi-region deployment — see "What this is not" below before citing it as more.

## Problem

Presence (`PresenceRegistry`, `PresenceService`) and typing indicators live entirely in Redis today: one `HINCRBY` for a user's live session count, one `HSET` for their status, TTL-backed so a dead pod's users expire instead of ghosting. That is correct and sufficient **because there is exactly one Redis instance** — every write is serialised through it, so "last write wins" has an unambiguous meaning and a shared counter can't diverge.

The moment a deployment has more than one region, each with its own Redis (or any store) for latency reasons, that assumption breaks: two regions can each accept a connect/disconnect for the same user, or a status change, with no shared clock and no coordinator. A naive merge (e.g. "whichever region's HTTP request reaches a reconciler last wins") silently loses updates and — under clock skew — can even undo a causally later change in favour of an earlier one that merely has a bigger wall-clock timestamp.

## Decision

Build the merge algorithms as a standalone, rigorously tested library (`presence/crdt/`), and reason about correctness the way the rest of this codebase does: state the property, then assert it, rather than assume it.

1. **`GCounter`** — grow-only counter, one slot per replica, merged by pointwise maximum. The foundation everything else is built from.
2. **`PNCounter`** — two `GCounter`s (increments, decrements); models "how many live sessions does this user have across every region", replacing the single Redis `HINCRBY` a multi-region deployment could no longer share.
3. **`HybridLogicalClock` / `HlcTimestamp`** — Kulkarni et al.'s HLC, the same clock family CockroachDB and MongoDB use. Ordered `(physical, logical, replicaId)`. The reason it exists rather than a raw `Instant`: a plain last-write-wins comparison of wall-clock time lets a **causally earlier** write beat a **causally later** one whenever the writer with the later real-world write happens to have a clock that reads behind. `HybridLogicalClock.update(remote)` folds a remote timestamp into the local clock so anything timestamped afterwards is provably ordered after it — the clock literally cannot violate causality, only wall-clock time can.
4. **`LwwRegister<T>`** — a single mutable field (status, status note) ordered by `HlcTimestamp` instead of raw time, for exactly that reason.
5. **`ReplicatedPresence`** — the worked example: composes a `PNCounter` (sessions) and an `LwwRegister<StatusNote>` (status) into the same shape `PresenceRegistry.Entry` already has, so it's obvious what this WOULD replace.

All four types are immutable value types — `merge`/`increment`/`set` return a new instance — mirroring the "commit produces the next state" pattern the client already uses for ratchet state (`doubleRatchet.ts`) rather than mutating shared state in place. Nothing here is a Spring bean; these are plain, dependency-free data types, unit-testable without Spring context, Redis or Testcontainers.

## What was actually verified

Every type is proven to be a join-semilattice — the formal property that makes a CRDT converge — not by assumption but by direct tests of the three laws:

- **Commutative**: `merge(a, b) == merge(b, a)`
- **Associative**: `merge(merge(a, b), c) == merge(a, merge(b, c))`
- **Idempotent**: `merge(a, a) == a`

`GCounterTest`, `PNCounterTest` and `LwwRegisterTest` assert all three directly. `PNCounterTest` and `ReplicatedPresenceTest` additionally run the realistic scenario the whole exercise is for — two regions independently handling connects/disconnects/status changes for the same user during a partition, merged in every order, asserting identical convergence. `HybridLogicalClockTest` and `LwwRegisterTest` specifically construct the clock-skew case: replica A's wall clock reads ahead, replica B's reads behind, B writes *after* receiving A's message, and the merge correctly picks B's write — the exact failure mode a naive wall-clock LWW register has and this doesn't. 26 tests, `mvnw verify` unaffected (39 unit + 25 IT still pass, JaCoCo gate held).

## What this is not

- **Not wired into `PresenceRegistry` or `PresenceService`.** They run correctly today against one Redis instance; swapping in CRDT merges there would add complexity and a real regression risk for zero benefit until there is more than one instance to reconcile. Replacing a working single-writer system with a multi-writer conflict-resolution scheme it doesn't need would be the wrong trade, the same reasoning ADR-0003 originally used to reject the Double Ratchet until the vault made it worth the cost.
- **Not a deployed multi-region system.** There is no second region, no cross-region transport, and no infrastructure this was run against. What's demonstrated is that the merge algorithm converges correctly in isolation — the piece a single repository session can actually prove.
- **Would still need, for a real deployment:** a stable, unique `replicaId` per region/pod (today's `HOSTNAME`-derived pod id is close but would need to be region-qualified); a transport to exchange replica states (Kafka MirrorMaker, Redis Enterprise CRDB, or a custom gossip protocol — none of which exist in this repo); NTP-bounded clock drift, since HLC bounds *causal* reordering but its physical component still drifts from true wall-clock time if the underlying clock is badly wrong; and a decision on full-state vs. delta-state replication, since shipping the entire replica-count map on every gossip round doesn't scale indefinitely (delta-state CRDTs exist specifically for this and are the natural next step, not implemented here).
- **Session count can transiently look wrong mid-convergence.** A region that has only ever seen a user's disconnect (because it joined the mesh late, after a connect happened elsewhere) contributes 0 to increments and 1 to decrements for that replica slot until it also learns of the matching connect — the merged total is temporarily off by exactly the events that haven't propagated yet, which is inherent to eventual consistency, not a bug in the merge.
