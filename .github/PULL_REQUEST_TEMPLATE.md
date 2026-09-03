## What

<!-- One paragraph: the change and why. Link the issue if there is one. -->

## Guarantees touched

- [ ] Exactly-once send path (`clientMessageId`, sequence, unique indexes)
- [ ] E2EE DM protocol / replay backstop
- [ ] Kafka outbox / consumers / DLT
- [ ] Auth, sessions, 2FA
- [ ] None of the above

## Verification

- [ ] `./mvnw verify` green locally (unit + Testcontainers ITs + coverage gate)
- [ ] Frontend: `npm run lint && npm run typecheck && npm test -- --run`
- [ ] Docs updated where behaviour changed (`docs/`, `README.md` verification table)

## Rollout

<!-- Migration? Config/env change? Feature flag? Rollback plan? -->
