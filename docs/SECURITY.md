# Security

## Threat model in one paragraph

CipherChat is deployed by an organisation for its own people. The adversaries that matter: an outsider on the network, a compromised or curious **operator** of the server, a stolen device/token, and a hostile *authenticated* user. The one thing the design does **not** claim: protection against a malicious client build served by the same operator — that is inherent to web E2EE and stated rather than hidden.

## Authentication

| Mechanism | Detail |
|---|---|
| Passwords | BCrypt cost 12; constant dummy hash on unknown emails so response time does not reveal account existence |
| Access token | HS256 JWT, **15 minutes**, claims `sub`, `email`, `role`; secret ≥ 32 bytes, app refuses to boot in `prod` with the dev default |
| Refresh token | 30 days, random 256-bit, **stored as SHA-256**, httpOnly `SameSite=Lax` cookie scoped to `/api/v1/auth`; rotated on every use with atomic consume — a replayed token yields 401 and an audit event |
| Sessions | one refresh row = one device; users list and revoke them; password change revokes every *other* device |
| 2FA | TOTP (RFC 6238, self-implemented, ±1 step), seed sealed with AES-256-GCM under a key derived from `SEAL_SECRET`; 8 single-use BCrypt-hashed backup codes; login with 2FA enabled returns a **scoped pending token** that every API path rejects — the password alone never yields a session |
| WebSocket | JWT presented in the STOMP `CONNECT` header, never in the URL (proxies log URLs); unauthenticated frames are rejected before routing |

## Authorization

- Spring Security: stateless, CSRF disabled (bearer tokens, no cookie-authenticated mutations except the refresh endpoint, which only rotates), `/api/v1/admin/**` requires `ROLE_ADMIN`, everything else authenticated except auth/health/docs.
- Domain-level checks live in the services, not controllers: room access (`ChatroomService.assertAccess`), DM participation (`DmService.requireParticipant`), message ownership for edit/delete, owner/admin for invite/role changes. A valid token for the wrong user gets 403 with a stable `code`.
- STOMP `SUBSCRIBE` to `/topic/rooms/{id}` and `/topic/dm/{id}` is authorised by membership before the subscription is registered.

## Transport & headers

TLS terminates at the ALB/ingress (ACM); pods speak HTTP inside the VPC. `server.forward-headers-strategy: native` so client IPs and scheme survive the proxy. Cookies are `Secure` in `prod`. CORS is an explicit origin allow-list with credentials (`CORS_ALLOWED_ORIGINS`); Spring rejects a `*` origin combined with credentials at request time, so a misconfigured wildcard fails closed rather than opening the API.

## Input handling

- Bean Validation on every request record (lengths, patterns, ranges); violations are `400 validation_failed` with a `fields` map.
- Full-text search uses `plainto_tsquery` (no operator injection); the ILIKE fallback escapes `%`, `_` and `\`.
- Upload MIME allow-list for room attachments; encrypted blobs must be `application/octet-stream`; filenames are metadata only — storage keys are random UUIDs, so path traversal is impossible by construction.
- E2EE envelopes are validated **structurally** (version, base64, key lengths, 16 KB ciphertext cap, no extra fields) so the opaque channel cannot be used as arbitrary storage.
- STOMP inbound frame size capped at 64 KB.

## Rate limiting

Redis Lua token bucket, atomic, shared across replicas: messages 20 burst / 2 per s per user (REST and STOMP), uploads 30/min, AI calls 20/min. Fails **open** if Redis is unreachable (availability over strictness for a chat), which is logged.

## Secrets

Never in the repository. Local: environment variables with obviously-fake defaults that the `prod` profile rejects. Kubernetes: `Secret` populated from AWS Secrets Manager (External Secrets), RDS master password managed by RDS, S3 access via IRSA (no static keys). `.env` files and `bob-state.json` are git-ignored; CI scans lockfiles and images with Trivy.

## Audit trail

Security-relevant actions publish `Audited` events → Kafka `audit-events` → append-only `audit_logs` (actor, action, target, metadata, IP, producer timestamp). Failed logins and refresh replays are published in a **detached transaction** so the failure's rollback cannot erase the evidence. Read-only admin endpoint.

## End-to-end encryption (DMs)

Protocol summary (client-side, `chat-front/src/crypto`): X3DH-lite session setup (identity X25519 + Ed25519-signed prekey), per-direction HMAC-SHA256 chain ratchets, per-counter HKDF message keys, AES-256-GCM with AAD over `{v, conversationId, senderId, sessionId, ctr}`, plaintext padded to 256-byte buckets, session rotation every 200 messages / 7 days. Full rationale in the ADRs under `docs/adr`.

The server's role, and its only cryptographic operations:

1. **Key directory** — stores public bundles and **verifies the prekey signature with the identity key** (JDK Ed25519) so it cannot serve a mix-and-match bundle. Identity changes bump `keyVersion`; peers show a safety-number-changed banner.
2. **Replay backstop** — `UNIQUE (conversation, sender, sessionId, ctr)`; a counter is spent once, cluster-wide.
3. **Opaque recovery blob** — client-encrypted with a key from an 8-word recovery code; the server can lose it, never read it.

What the server can see: who talks to whom, when, how often, ciphertext sizes (bucketed). What it cannot: content, attachment names/types (they travel inside the envelope; the blob is `octet-stream`).

Rooms are **not** E2EE by design — the AI summarise/suggest features need server-readable transcripts, and rooms are the collaborative, searchable space. The UI labels the difference; this is a product trade-off, documented in ADR-0004.

## Observability without content

Logs never include message bodies. The `MessageSent` event carries a 120-character preview used only for the mention toast and notification row (rooms are server-readable anyway); DM events carry no content. Metrics are counts and timings.

## Known gaps

- No account lockout after N failed logins (rate limiter + audit only) — a deliberate choice against user-facing DoS; revisit with IP reputation.
- Single-device E2EE identity (documented limitation; multi-device would need per-device keys and sender-keys for fan-out).
- Password reset by email is not implemented (no mail sender); admins reset via the database in this version.
