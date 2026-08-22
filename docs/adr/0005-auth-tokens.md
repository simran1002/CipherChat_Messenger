# ADR-0005: 15-minute access tokens + rotating refresh cookie

**Status:** Accepted (Phase 0)

## Problem
JWTs were signed with **no expiry** and parked in `localStorage`: any leaked
token was a permanent credential, there was no logout on the server side, and
the signing library wrapped an EOL `jsonwebtoken@8` with no algorithm
allowlist.

## Requirement
Bound the blast radius of a leaked token to minutes; make sessions revocable;
keep the UX seamless (no visible re-logins); survive the socket layer's
long-lived connections.

## Decision
- **Access token:** HS256 (explicit allowlist), 15-minute expiry, payload
  `{id}` only. Carried as a Bearer header and in the socket handshake `auth`
  payload (not the query string, which proxies log).
- **Refresh token:** 256-bit opaque random value in an `httpOnly` cookie
  scoped to `/user`; only its SHA-256 hash is stored (a DB dump replays
  nothing). **Rotation on every use:** the presented token is atomically
  consumed (`findOneAndDelete`) and replaced; replay of a rotated token is
  the theft signal and yields 401.
- **Client:** axios interceptor does silent refresh + single request replay
  (concurrent 401s share one refresh promise); the socket's `auth` callback
  re-reads storage on every reconnect, so rotated tokens propagate
  automatically.

## Trade-off
- Access token in `localStorage` remains XSS-readable for its 15-minute
  life. Full httpOnly for the access token too would break the socket
  handshake and same-origin assumptions; the mitigation stack is short TTL +
  rotation + revocation. Stated as a known limitation.
- An established socket outlives its token's expiry until it reconnects —
  accepted: the handshake re-verifies on every reconnect, and sockets
  reconnect frequently in practice.
