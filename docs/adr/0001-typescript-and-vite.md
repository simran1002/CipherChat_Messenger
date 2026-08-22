# ADR-0001: TypeScript everywhere; Vite replaces CRA

**Status:** Accepted (Phase 0)

## Problem
The codebase was ~7,000 lines of untyped JavaScript. The socket layer alone
carries ~25 distinct event shapes between client and server, with payload
mismatches (e.g. the DM and chatroom paths disagreeing on field names)
discoverable only at runtime. The frontend build ran on Create React App,
which is deprecated and unmaintained. One dependency (`uuid`) wasn't even
declared — it resolved by accident through hoisting.

## Requirement
Every socket payload, REST response, and shared data shape must be checked at
compile time, on both sides of the wire, before any further feature work
multiplies the surface.

## Decision
- Strict TypeScript on both apps. Socket events are defined once as typed
  event maps (`chat-back/src/sockets/events.ts`, mirrored in
  `chat-front/src/types/socket.ts`) and given to `Socket<C2S, S2C>` — an
  event-name typo or payload drift is now a compile error.
- CRA → Vite 5 (dev server startup seconds → milliseconds, per-page code
  splitting via `React.lazy`, Vitest shares the config).
- The backend's 478-line `server.js` was decomposed into per-domain socket
  modules; the `throw "string"` error idiom (~30 sites) became a typed
  `HttpError(status, code, message)`.

## Trade-off
- Two copies of the event map (backend + frontend) must be kept in sync by
  discipline; a shared package would eliminate that but drags in a monorepo
  toolchain for ~150 duplicated lines. Revisit if a third client appears.
- Migration cost was one full phase with zero user-visible features — paid
  once, and every later phase (Redis, E2EE) leaned on the types heavily.
