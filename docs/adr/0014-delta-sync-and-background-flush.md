# ADR-0014: Sequence-based delta sync over CBOR, and background flush of the offline queue

**Status:** Accepted

## Problem

Two gaps on poor networks (field reporters, clinics on congested links):

1. **Reconnect cost.** After a drop, the client re-fetched a history page per room as JSON, including reactions and receipts it mostly already had.
2. **Closed tabs.** The IndexedDB outbox drained only while a page was open. A message written offline stayed unsent until the user came back.

## Decision

### Delta sync

`POST /api/v1/sync/rooms` with `{rooms: {roomId: lastSeq}, maxPerRoom}` returns, per room, only the messages after the caller's cursor (a forward seek on the existing `(chatroom_id, sequence_number)` index), the room watermark, and a `more` flag. A room the caller can no longer read is reported as `denied` instead of failing the batch. Rows are a compact projection with short keys; reactions and receipts continue to arrive live.

The response is content-negotiated: `Accept: application/cbor` returns the same structure in CBOR (Jackson 3 data format on the server, `cbor-x` on the client, JSON fallback by content type).

**Measured** (`DeltaSyncIT`, real stack): 15 messages = 3,298 bytes JSON vs 2,610 bytes CBOR (79 %). The honest headline is not the encoding: it is not re-downloading history at all. CBOR's share grows if UUIDs move to 16-byte binary (they are strings today for JSON parity) — a follow-up, not a claim.

Live frames stay JSON over STOMP. The bulk transfer is the reconnect, which is request/response anyway; binary STOMP frames would add a second converter path for little gain.

### Background flush

`public/sw.js` registers a Background Sync tag. When connectivity returns and **no window is open**, it rotates the httpOnly refresh cookie for an access token and POSTs the queued items to the REST send endpoints. It has no fetch handler and caches nothing.

Why flushing blind is safe: every item carries a `clientMessageId` (a replay is absorbed by the unique index and answered `duplicate: true`); DM items are already sealed envelopes (encryption happens before enqueue, so the worker never sees plaintext or keys); permanent rejections (4xx other than 429) are dropped so a revoked room cannot wedge the queue; 429/5xx/network errors rethrow so the browser retries with backoff.

## Failure modes

| Failure | Handling | Signal |
|---|---|---|
| Live frames race the sync response | De-duplicate by message id, order by sequence, never by arrival. | — |
| Client far behind (thousands of messages) | `more` flag + bounded pages (`catchUpRoom`, max 20 pages) instead of one huge response. | `cipherchat_sync_gap_messages` (distribution), `cipherchat_sync_requests_total{format}` |
| Membership revoked while offline | `denied: true` for that room; the rest of the batch still syncs. | — |
| Page and worker both flush | The worker stands down when any window client exists; if both send anyway, idempotency makes it harmless. | `cipherchat_send_duplicates_total` |
| Refresh-token rotation race (worker rotates while a page wakes) | The worker only runs with no open window. A page that opens mid-flush may see one 401 and refreshes normally. | `user.refresh_rejected` audit events |
| Cross-site deployment | A `SameSite=Lax` refresh cookie is not sent from the worker to a different site: background flush needs the API on the same site as the app (ingress or reverse proxy). The page drain is unaffected. | — |
| Background Sync unsupported (Firefox, Safari) | The worker is nudged on the `online` event while a page exists; otherwise the reconnect drain covers it. | — |
