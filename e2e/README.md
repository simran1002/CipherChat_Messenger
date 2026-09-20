# End-to-end tests

Playwright tests against a **running** CipherChat stack. Nothing here starts the application.

```bash
docker compose up -d --build --wait     # from the repository root
cd e2e
npm ci
npx playwright install chromium
npm test                                # both projects
npm run test:api                        # HTTP + STOMP, no browser
npm run test:ui                         # real Chromium contexts
```

| Variable | Default | |
|---|---|---|
| `E2E_WEB_URL` | `http://localhost:3000` | the nginx-served frontend |
| `E2E_API_URL` | `http://localhost:8080` | the backend, or the load balancer of the scale profile |
| `E2E_CHROMIUM_PATH` | — | reuse an installed Chromium instead of Playwright's own |

Layout: `tests/api` (hostile-client security and delivery specs), `tests/ui` (multi-user browser flows), `support/` (API helpers, a minimal STOMP client, UI page helpers).

What each spec guarantees, what running it found, and the conventions to follow when adding one: [docs/TESTING.md](../docs/TESTING.md).
