# ADR-0003: E2EE protocol — Megolm-style chains, not Double Ratchet, not libsignal

**Status:** Accepted (Phase 3)

## Problem
"Cipher" Messenger stored and relayed every DM in plaintext: one database
dump, one curious operator, or one subpoena away from every private
conversation. A protocol was needed that one engineer can implement
*correctly*, test exhaustively, and defend line by line.

## Requirement
DM content must be unreadable to the server (at rest and in transit through
it), with: honest forward-secrecy properties, out-of-order delivery safety,
offline-queue compatibility, history that survives a page reload, and a
complete test story (RFC vectors, tamper, replay).

## Decision
- **Session setup — X3DH-lite:** 3-DH (IK_A×SPK_B, EK_A×IK_B, EK_A×SPK_B)
  without one-time prekeys; the prekey is Ed25519-signed and verified by
  both the server (the only crypto it can check) and the peer.
- **Per-direction symmetric chains:** `ck_{n+1} = HMAC-SHA256(ck_n, 0x02)`;
  message key + IV derived per counter via HKDF. Nonce reuse is structurally
  impossible (IV never travels).
- **AES-256-GCM** with AAD binding `{v, conversationId, senderId, sessionId,
  ctr}` — moving a ciphertext anywhere breaks the tag. Plaintext padded to
  256-byte buckets.
- **Counter-addressed decryption:** any message key is reachable by ratchet
  position, so out-of-order arrival, queued-offline sends, and full history
  replay need zero skipped-key bookkeeping.
- **Rotation:** new session every 200 messages or 7 days → forward secrecy at
  session granularity (compromise window bounded by the rotation policy).
- **Primitives:** @noble/curves + @noble/hashes + @noble/ciphers (audited,
  dependency-free, byte-testable against RFC 7748/8032/5869 + NIST GCM
  vectors). WebCrypto is used only where non-extractability buys something:
  the at-rest wrapping key in IndexedDB.

## Rejected alternatives
- **Self-implemented Double Ratchet:** per-message forward secrecy, but the
  skipped-message-key store across DH epochs, simultaneous-ratchet races,
  and two-tabs-sharing-IndexedDB state corruption are exactly where solo
  implementations go subtly wrong. A correct, honestly-scoped protocol beats
  a subtly broken stronger one. The `v` field and per-session design leave
  the upgrade open (a DH ratchet is "new session per step").
- **libsignal:** the real thing, but WASM packaging pain on the web, and the
  engineering story becomes "I integrated a black box."

## Trade-off
Forward secrecy is session-granular, not message-granular — stated plainly
in the threat model. In exchange: implementable, fully tested, and history
stays decryptable from stored ciphertext (the same trade Matrix's Megolm
makes for group messaging).
