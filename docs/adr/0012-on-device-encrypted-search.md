# ADR-0012: On-device encrypted search for E2EE direct messages

**Status:** Accepted

## Problem

Users expect to search their messages. For direct messages the server holds only ciphertext, so server-side search is impossible without breaking the product's central promise. The previous implementation filtered the messages currently loaded in memory by substring: no ranking, no typo tolerance, nothing beyond the visible page, and all of it on the main thread.

## Decision

Search where the plaintext already is: on the device.

- **Index**: Orama (`search/searchCore.ts`) over decrypted DMs — stemming, edit-distance-1 tolerance, conversation filter, dedupe on message id + text, per-conversation delete.
- **Off the main thread**: the index lives in a Web Worker (`search/search.worker.ts`, a separate 72 kB chunk). Indexing a long history never blocks typing or scrolling; the page talks to it through a small promise API (`searchClient.ts`) and degrades to the substring filter where Workers are unavailable.
- **Encrypted at rest**: what the worker persists is a snapshot *per conversation*, sealed with AES-256-GCM under a non-extractable WebCrypto key in its own IndexedDB database (`CipherChatSearch`). The conversation id is bound as associated data, so a blob cannot be moved under another conversation's row.
- **Lifecycle**: shredding a conversation (ADR-0011) deletes its snapshot and its documents; a key reset wipes the index and its key.

### Why not SQLite-WASM with FTS5

It scales further (OPFS-backed, tens of thousands of messages without holding the index in memory), but the official build has no page encryption: FTS5 shadow tables would sit in plaintext on disk unless an encrypting VFS is added. For a product whose point is that plaintext does not rest anywhere unencrypted, the simpler engine with fully sealed snapshots is the right v1. The `SearchCore` interface is engine-agnostic; SQLite with an encrypting VFS is the path beyond roughly 50k messages per device.

## Failure modes

| Failure | Handling | Signal |
|---|---|---|
| Snapshot cannot be opened (key reset, corruption, truncated write) | The blob is dropped, not trusted; the index rebuilds as conversations are opened and re-decrypted. AES-GCM makes partial reads impossible to mistake for data. | — |
| IndexedDB quota or transient write error during a heavy sync | Writes are debounced and batched per conversation; a failed conversation stays in the dirty set and is retried with the next batch. Search keeps working from memory. | — |
| Worker crash | Pending calls reject into the caller's fallback (empty hits → substring filter still applies); the worker is recreated lazily and rehydrates from snapshots. | — |
| Stale hits after edit/delete | `add()` replaces on changed text; delete removes; both mark the conversation dirty so the snapshot converges. | — |

## Consequences

- Search quality improves (ranking, stemming, typos) with zero server involvement; the server never learns a query.
- Coverage is what this device has decrypted; history never opened here is not searchable here. That is inherent to E2EE, and stated in the UI tooltip.
- The index is an additional at-rest copy of plaintext on the device, sealed under a non-extractable key: same exposure class as the key store, removed by the same shredding operation.
