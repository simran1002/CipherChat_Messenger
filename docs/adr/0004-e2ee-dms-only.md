# ADR-0004: E2EE for DMs only; rooms stay server-readable

**Status:** Accepted (Phase 3)

## Problem
The product has AI features (conversation summaries, reply suggestions) that
require the server to read room transcripts — and an E2EE ambition that
requires the server to read nothing. Both cannot hold for the same channel.

## Requirement
Private 1:1 conversations must be operator-proof. Room features (AI, full
server-side search, at-rest TTL enforcement) must keep working.

## Decision
Split-horizon by channel type, presented honestly in the UI:
- **DMs:** end-to-end encrypted (ADR-0003). The server stores envelopes,
  validates structure, and can never read content. AI features are absent
  from DMs *by construction*.
- **Rooms:** server-readable, clearly the "team space." AI summarize /
  suggest / tone, server-side search, and self-destruct TTL indexes operate
  on plaintext.

## Trade-off
- Room content trusts the operator — the same trust model as Slack/Teams,
  and the honest label for any channel with server-side AI features.
- Group E2EE (sender keys distributed over the pairwise DM channel,
  Megolm-style) is a documented future path, not a v1 promise; it would cost
  the room AI features for encrypted rooms.
- This is a *product* decision encoded in architecture: privacy tiers, not
  privacy theater. WhatsApp (E2EE, no server AI) and Slack (server AI, no
  E2EE) each picked one side; this system demonstrates both and the seam
  between them.
