# ADR-0011: Double Ratchet sessions (envelope v2) and cryptographic shredding

**Status:** Accepted — opt-in for sessions a device starts; supersedes the forward-secrecy position of ADR-0003 for v2 sessions. v1 sessions remain supported.

## Problem

ADR-0003 chose counter-addressed chain sessions: `messageKeyAt(chainRoot, n)` re-derives any message key from a stored chain root. That made out-of-order delivery, offline queues and history re-decryption trivial, and it was honest about the price: forward secrecy is **per session** (200 messages / 7 days). A device seized today opens every message of its live sessions, and the sender can always re-open its own ciphertext from the server.

For the people this product is for (a clinic, a newsroom, a legal team), "whoever takes this laptop reads the last week" is the wrong default. They also need a credible answer to "how do I destroy a conversation?".

## What changed since ADR-0003

ADR-0003 rejected the Double Ratchet because deleting message keys is incompatible with re-decrypting history from the server. That constraint is now removed by a **local encrypted vault**: plaintext is kept on the device, sealed under a per-conversation key, so keys can be destroyed the moment they are used.

## Decision

1. **Protocol.** Signal's Double Ratchet over the existing primitives (`crypto/doubleRatchet.ts`): X25519 DH ratchet, HKDF-SHA256 root chain, HMAC-SHA256 symmetric chains, AES-256-GCM with the ratchet header bound as associated data. Session setup reuses the X3DH inputs of v1 with a distinct KDF label; the responder's first ratchet key is its signed prekey.
2. **Wire format v2** (`crypto/envelopeV2.ts`): `{v:2, sessionId, ctr, dh, pn, n, ct, init?}`. `ctr` is the sender's monotonic send count on the session, so the server's replay index `UNIQUE(conversation, sender, sessionId, ctr)` works unchanged without the server understanding the ratchet. The server validates shape only (`EnvelopeValidator`).
3. **Vault** (`crypto/vault.ts`): IndexedDB `CipherChatVault` with one non-extractable AES-256-GCM key per conversation; ratchet state and decrypted plaintext are sealed under it. `commit()` writes the advanced ratchet and the plaintext it produced in **one** IndexedDB transaction.
4. **Cryptographic shredding**: deleting a conversation's key row makes its sealed history and ratchet unrecoverable on that device; v1 sessions, preview and search snapshot for the conversation are removed in the same operation. It is a local guarantee, not a remote wipe.
5. **Rollout**: decrypt dispatches on `envelope.v`. A device opts in (`CC_E2EE_V2`) for sessions it *starts*; a conversation the peer started on v2 is answered on v2 regardless. Opt-in, not default, because v2 sessions are deliberately **not** included in the recovery-code backup (a backed-up ratchet restored on a second browser would fork the state), which changes the "restore on a new browser" experience.

## Properties, as tested

`doubleRatchet.test.ts` (12), `envelopeV2.test.ts` (7), `liveV2.e2e.test.ts` (against the running server): in-order and out-of-order delivery, late frames from a previous chain, replay rejected, forged/corrupted frames never advance state (decrypt is transactional), associated-data binding, `MAX_SKIP` enforcement, serialisation between every step, and post-compromise recovery — a stolen state is locked out once the victim uses a ratchet key generated after the theft (at most two round trips; the copy contains the victim's *current* ratchet private key, so one more step remains readable).

## Failure modes

| Failure | Handling | Signal |
|---|---|---|
| Out-of-order / lost frames across a reconnect | Skipped message keys, bounded per step (`MAX_SKIP` 1000) and in total (2000, oldest evicted), expirable by age. A frame beyond the bound is refused rather than forcing unbounded key derivation (DoS guard). | typed `RatchetError.code` surfaced to the UI as an undecryptable bubble. There is no client telemetry pipeline yet; a counter per code is the first metric to add. |
| Crash between ratchet advance and plaintext save | Impossible by construction: one IndexedDB transaction. If the transaction aborts, neither is persisted and the frame decrypts again from the unchanged state. | — |
| Two tabs decrypting the same frame | Cross-tab lock (`navigator.locks`) around ratchet use; the second tab finds the plaintext in the vault and never touches the ratchet. | — |
| Sender crash after encrypt, before send | The state is committed before the envelope is returned, so a message number is burned, never reused (nonce reuse is impossible). The offline queue holds the sealed envelope; replays are absorbed by `clientMessageId` and the replay index. | server: `cipherchat_send_duplicates_total`, `409 replayed_counter` responses in `http_server_requests_seconds_count{status="409"}` |
| Peer shredded or reset mid-session | Their next send starts a new session (init block attached); our newest-session rule answers on it. Frames still in flight on the old session show as undecryptable — by design, the key is gone. | — |
| Malicious server reordering/dropping | Reordering is tolerated (skipped keys); dropping is visible to users as gaps but not detectable cryptographically in a two-party ratchet. Out of scope: transcript consistency. | — |

## Consequences

- Per-message forward secrecy and post-compromise security for v2 conversations.
- History is device-local for v2: a new browser does not see old v2 messages, and the sender cannot re-open its own ciphertext from the server (its plaintext is in its vault). This is the same trade Signal makes.
- Still single-device per account. Per-device sessions (Sesame) and one-time prekeys are the next step; the envelope and the replay index already accommodate them (`recipient_device` would join the key).
- Browser storage deletion is not secure erasure. The guarantee rests on the conversation key having been non-extractable, not on overwriting blobs.
