import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a RUNNING stack — nothing here starts the application:
 *
 *   docker compose up -d --build --wait        # postgres + redis + kafka + backend (:8080) + nginx frontend (:3000)
 *   cd e2e && npm ci && npx playwright install chromium && npm test
 *
 * Two projects:
 *   api — raw HTTP and STOMP clients, no browser. Security and delivery guarantees as a hostile or flaky client sees them.
 *   ui  — real Chromium contexts, one per simulated user, driving the production nginx build.
 */
export const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:3000";
export const API_URL = process.env.E2E_API_URL ?? "http://localhost:8080";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // flows inside a file are ordered; files still run in parallel across workers
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : 3,
  reporter: isCI
    ? [["list"], ["html", { open: "never" }], ["github"], ["junit", { outputFile: "test-results/junit.xml" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "api", testDir: "./tests/api" },
    {
      name: "ui",
      testDir: "./tests/ui",
      use: {
        ...devices["Desktop Chrome"],
        // Optional: reuse a Chromium that is already installed instead of Playwright's own build.
        launchOptions: process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {},
      },
    },
  ],
});
