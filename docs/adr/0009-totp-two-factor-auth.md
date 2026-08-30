# ADR-0009: TOTP two-factor authentication with scoped pending tokens

**Status:** Accepted

## Problem
For the target customer (orgs holding sensitive conversations), a phished or
reused password was the whole ballgame: one credential opened the account,
its DMs' metadata, its rooms, and its session list. Every other part of the
auth stack (15-minute tokens, rotating refresh cookies, theft tripwires)
assumed the password ceremony itself was sound.

## Requirement
A second factor that works fully self-hosted — no SMS gateway, no email
round-trip, no third-party identity provider — and that cannot weaken the
existing single-step flow for accounts that don't enable it.

## Decision
- **TOTP (RFC 6238)** via `otplib`, enrolled by QR code or manual base32
  entry, confirmed with a live code before it activates (a mis-scanned
  authenticator can never lock the account).
- **Two-step login with a scoped pending token.** A correct password on a
  2FA account yields only a 5-minute JWT carrying `scope: "2fa-pending"` —
  no access token, no refresh cookie, no presence flip. The access-token
  verifier rejects **any** token bearing a scope claim, so the pending token
  is cryptographically real but useless everywhere except `/user/login/2fa`.
  (An access token is exactly `{id}`; scope-bearing tokens are a different
  species by construction.)
- **8 single-use backup codes**, shown once, stored as bcrypt hashes,
  spliced out as they're consumed.
- **Seed sealed at rest**: the base32 secret is AES-256-GCM-encrypted under
  a key derived from the server SECRET (`utils/secretBox.ts`), so a database
  dump alone can't mint valid codes — unlike passwords, TOTP seeds must be
  *recomputable*, so hashing is not an option and sealing is the honest
  next-best.
- **Dedicated rate bucket**: `/user/login/2fa` gets 10 attempts / 5 min / IP
  (Redis-shared), because a 6-digit code inside the generic 100-per-window
  bucket would hand a password thief 100 guesses per window.
- Disabling requires the password **and** a current code — a hijacked
  session alone can't strip the account's second factor.

## Trade-off
- No SMS/email fallback is deliberate (self-hosted constraint), so losing
  the authenticator *and* the backup codes means account recovery becomes an
  operator action. Documented, not hidden.
- The TOTP seed is recoverable by an attacker who has BOTH the database and
  the server's environment — the same trust boundary the E2EE design already
  draws (the server is honest-but-curious about content, and auth is a
  server-side concern by definition).
- otplib v13 is ESM-first; its CJS entry point pulls an ESM-only dependency
  and crashes a compiled CommonJS server at boot. It is loaded through a
  dynamic `import()` (preserved by tsc under `module: NodeNext`) — the kind
  of packaging landmine worth writing down.
