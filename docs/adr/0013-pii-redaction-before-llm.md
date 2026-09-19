# ADR-0013: Client-side PII redaction in front of the LLM gateway

**Status:** Accepted

## Problem

Room summaries send conversation text to a language model, which for most deployments is a third party. A clinic's room contains patient names, phone numbers and record numbers; a newsroom's contains sources. "We have a DPA with the provider" is a policy answer. The engineering answer is to not send identifiable data at all.

Scope, stated precisely: **rooms are not end-to-end encrypted** (ADR-0004), so the server already sees room plaintext. This control protects against the *model provider*. For E2EE direct messages it is also the *only* possible route to a summary, because the server has no plaintext to build a prompt from.

## Decision

Redact on the device, verify on the server, rehydrate on the device.

1. **Client** (`privacy/piiRedactor.ts`): deterministic detectors replace entities with stable tokens — `[PERSON_1]`, `[EMAIL_1]`, `[PHONE_1]`, `[CARD_1]` (Luhn-checked), `[GOV_ID_1]`, `[MRN_1]`, `[IP_1]`, `[URL_1]`. Names come from a caller-supplied dictionary (the room roster and the speakers), longest match first. The token → value map stays in the function's scope and is never transmitted. A self-check refuses to send if anything detectable remains.
2. **Gateway** (`POST /api/v1/ai/summarize-redacted`): receives the redacted transcript, **re-scans it independently** (`PiiGuard`) and fails closed with `422 pii_detected` naming the detector — a client bug or a modified client cannot leak to the model. Behind it: per-user rate limit, Resilience4j retry and circuit breaker (`503 ai_unavailable` when open).
3. **Audit**: the audit event stores entity *counts*, the policy version and the line count. Never text.
4. **Client**: `rehydrate()` replaces tokens in the model's answer. The prompt instructs the model to keep bracketed tokens verbatim.

## What this is not

It is a data-minimisation control, not a compliance certificate. It does not detect free-text names outside the roster ("my neighbour Asha"), addresses, or identifying context ("the mayor's daughter"). Those need an NER model (planned as an optional on-device model) and human judgement. The UI states how many identifiers were replaced; it does not claim the text is anonymous.

## Failure modes

| Failure | Handling | Signal |
|---|---|---|
| Client detector misses a structured identifier | Server second line refuses the request before any model call. | `cipherchat_ai_redacted_requests_total{outcome="pii_detected"}`, WARN log with detector names only |
| Model drops or alters a token | `rehydrate()` leaves unknown tokens as they are: the user sees `[PERSON_3]`, never a wrong name. | — |
| Model provider slow or down | Circuit opens after 50 % failures over 10 calls; callers get an immediate 503 for 30 s instead of holding threads. | `resilience4j_circuitbreaker_state{name="llm"}`, `…requests_total{outcome="unavailable"}` |
| Prompt injection inside a message ("ignore the above…") | Bounded blast radius: no tools, output shown only to the requesting user, tokens rather than identities in the context. | — |
| Over-redaction hurting summary quality | Same value → same token within a request, so the model can still follow who said what. | `entityCounts` in the audit trail for tuning |
