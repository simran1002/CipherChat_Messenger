# ADR-0007: Delivery guarantees — at-least-once transport, exactly-once persistence

**Status:** Accepted (Phases 0–2; layered design predates this repo's overhaul)

## Problem
"The message sent fine on my machine" is not a guarantee. Sockets drop,
tabs crash mid-send, retries race across replicas, and reconnecting clients
replay everything they queued. Naive handling yields the two classic
failures: silently lost messages and duplicated messages.

## Requirement
A message accepted by the UI must eventually persist exactly once and appear
to every room member in a consistent order — through packet loss, pod
restarts, pod *kills*, and offline periods.

## Decision — five layers, each covering the one above it
1. **Client ACK + retry:** every send carries a UUID `clientMessageId`;
   `socket.timeout(5s).emit` retries with exponential backoff + jitter
   (1s→8s). Terminal rejections (`forbidden`, `invalid_message`) do NOT
   retry.
2. **Offline queue:** after 4 failed retries (or while disconnected) the
   payload lands in IndexedDB and drains on reconnect (batch event, per-item
   results).
3. **Server dedup:** `SET NX` on the clientMessageId — a retry or drained
   duplicate is ACKed with the original server id, never re-persisted.
4. **Per-room sequences:** Redis `INCR`, seeded from Mongo max on first use,
   so restarts never re-issue numbers; clients order by sequence.
5. **DB backstop:** unique partial indexes on `clientMessageId` and
   `{chatroom, sequenceNumber}` — if every layer above fails, the write is
   rejected, not duplicated.

The optimistic UI bubble (`_pending`) reconciles by `clientMessageId` when
the broadcast echo arrives; the reconciliation is idempotent (a re-delivered
echo can never double-render).

## Trade-off
- At-least-once transport means the *dedup layer is load-bearing* — hence
  the DB unique indexes as the last line, and integration tests that
  deliberately double-send.
- Sequence numbers are per-room, not global — global ordering is neither
  needed nor cheap. Cross-room ordering is undefined by design.
- The 5s ack timeout + 4 retries means a genuinely dead server holds a
  "sending…" state for ~20s before queueing; tunable constants, documented
  in the hook.
