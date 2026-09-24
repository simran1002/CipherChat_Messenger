# Testing

Four layers, cheapest first. The classes, sequences and state machines these layers exercise are drawn in [LLD.md](LLD.md). Each layer exists because the one below it cannot see a whole class of failure — and the top layer earned its place by finding real defects the lower ones had passed.

| Layer | What it proves | Where | Run | CI job |
|---|---|---|---|---|
| **Unit** (backend, frontend) | Pure logic: crypto against RFC/NIST vectors, CRDT semilattice laws, throttle keys, redaction, ratchet state | `backend/src/test`, `chat-front/src/**/*.test.ts(x)` | `./mvnw test`, `npm test` | `backend`, `frontend` |
| **Integration** | The contract over REAL Postgres 17, Redis 7 and Kafka (Testcontainers): auth, exactly-once, STOMP, outbox, replay | `backend/src/test/**/*IT.java` | `./mvnw verify` | `backend` |
| **End to end** | The whole composed stack (production nginx + backend images) driven by real Chromium contexts and raw HTTP/STOMP clients | `e2e/` | `npm run test:e2e` (root) | `e2e` |
| **Chaos and scale** | Behaviour when infrastructure fails: Redis paused, Kafka stopped for longer than the producer timeout, a replica SIGKILLed mid-conversation | `scripts/verify-*.py` | see below | `e2e` (chaos), `scale.yml` (replicas) |

## Running everything locally

```bash
docker compose up -d --build --wait            # postgres, redis, kafka, backend :8080, nginx frontend :3000
AUTH_RATE_LIMIT_PER_15M=1000000 docker compose up -d backend   # optional: many accounts from one address
cd e2e && npm ci && npx playwright install chromium && npm test
python scripts/verify-stack.py --chaos         # + Redis/Kafka failure drills (~9 min, needs `pip install websocket-client`)

# two replicas behind the load balancer
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --scale backend=2 --wait
python scripts/verify-fanout.py                # a message via replica A reaches a subscriber on replica B
python scripts/verify-failover.py              # SIGKILL the sender's replica mid-stream; assert the database
```

`npm run test:api` and `npm run test:ui` (in `e2e/`) run the two Playwright projects separately. Failed UI tests keep a trace, screenshot and video under `e2e/test-results`; open a trace with `npx playwright show-trace <trace.zip>`.

## What the end-to-end suite guarantees

**API project** (`e2e/tests/api/security.spec.ts`, 17 tests, no browser — a hostile or flaky client)

| Guarantee | Test |
|---|---|
| A signed-in user cannot forge a room message or another user's private event through the broker; genuine `/app` sends still work | STOMP gateway › forge |
| Outsiders receive nothing from a private room (asserted on the outcome, not on the absence of a reply) | STOMP gateway › outsider |
| A racing second tab is refused without revoking anything; replaying a stolen, already-rotated cookie revokes the whole family — the thief's live token too | sessions › rotation and reuse |
| Guessing one account's password is cut off after 10 attempts, without locking out anyone else | login throttling |
| A file named `.html` but declared `image/png` is stored and served as PNG with `nosniff`; HTML and SVG are refused | uploads |
| Anonymous callers, non-admins and non-members are refused; CORS allows only the app's origin | authorization and CORS |
| A client id reused in another room is a new message, never the other room's content | exactly-once › scoping |
| 30 concurrent sends from 3 users get gapless sequences; re-sending every one is absorbed as a duplicate | exactly-once › concurrency |
| Delta sync returns only what is missing, as JSON or CBOR | exactly-once › delta sync |
| Identifiable data that survives client-side redaction is refused before any model call | AI gateway privacy |

**UI project** (`e2e/tests/ui/`, 17 tests, real Chromium, one isolated context per simulated user)

| Guarantee | Spec |
|---|---|
| Landing page describes the Java stack, makes no stale claims; 404 and route guards work | `auth.spec.ts` |
| Registering signs you in immediately; sign-out, wrong password and re-login behave; a session survives a reload | `auth.spec.ts` |
| Two users exchange end-to-end encrypted messages; the server's copy contains ciphertext only; replies arrive live | `direct-messages.spec.ts` |
| The encryption status panel reports the real protocol and upgrading to the Double Ratchet really switches it | `direct-messages.spec.ts` |
| ⌘K/Ctrl+K searches every conversation on the device; shredding destroys readable history locally without touching the peer's copy | `direct-messages.spec.ts` |
| A different account on the same browser — in the same tab, with no reload — never inherits the previous account's keys; the same account keeps its own | `account-isolation.spec.ts` |
| Room messages reach the other member live and are stored exactly once, in order; a message sent offline is delivered once on reconnect | `chatrooms.spec.ts` |

## What running it found

The end-to-end layer was added after every lower layer was already green. It then found:

- **Live DMs never rendered.** The server's `newDirectMessage` frame carried no `conversationId` and nested the sender as `user{}`; the client routes frames by a top-level `conversationId`, so every live message in an open conversation was dropped. Only history fetched on open (or your own optimistic bubble) showed. API-level integration tests could not see it. Fixed on both sides of the contract; pinned by `StompGatewayIT` and the DM E2E flow.
- **Joins before the socket connects were lost.** A hard refresh or deep link joins its room at mount, before STOMP finished connecting; the join was dropped and never replayed, so the page intermittently received no live messages. Fixed (`stompSocket.ts` remembers wanted subscriptions and replays them on connect; leaving while disconnected no longer throws). Unit-tested; the tests fail on the previous code.
- **A second account in the same tab inherited the first account's encryption identity.** The key-store wipe on account switch was correct, but `E2EEService` is a singleton that cached the previous identity in memory. Fixed; covered by `account-isolation.spec.ts` and `DeviceOwner.test.ts`.
- **`/actuator/health` took 60 s to report Kafka DOWN.** The probe's `AdminClient.close()` waited out Kafka's default timeout. Now 4 s; `KafkaHealthIndicatorTest` takes 60.9 s and fails on the old code.
- **The outbox was only replayed on restart.** Events published during a Kafka outage longer than the producer's 60 s delivery timeout stayed undelivered until pods restarted. `OutboxResubmitter` now retries them on a timer, one elected replica per tick; the chaos drill has a prolonged-outage phase that proves it without a restart.
- **The scale profile could not run as documented.** `ports: []` does not clear a published port when Compose merges files; it is now `!reset []`. The kill-a-pod script had never been run: it now has, and passes (7/7).

## Conventions

- E2E tests run against a **running** stack; they never start the application. Every user is created by the test with a unique name and email, so files run in parallel and reruns never collide.
- Assertions target **outcomes** (what the database holds, what a subscriber received), never merely the absence of an error. A UI bubble that appears optimistically is not evidence of delivery.
- `AUTH_RATE_LIMIT_PER_15M` raises the per-address registration/login budget for automated runs. The per-account login limit is separate and is itself under test.
- Integration tests share one Spring context and one set of containers; do not add class-level `@TestPropertySource` overrides, which would start a second set.

## Known limits

- The suite runs one browser engine (Chromium) at one viewport.
- Failure-injection drills use the Compose stack on one machine; they prove the application's behaviour, not a cloud provider's.
- Most security regression tests passed against the fixed code and were not additionally shown to fail against the vulnerable code. Proven both ways: the `stompSocket` join/leave tests and `KafkaHealthIndicatorTest`; the STOMP forgery was also reproduced live before it was fixed.
