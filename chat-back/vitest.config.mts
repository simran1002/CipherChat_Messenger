import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./tests/helpers/setupEnv.ts"],
    // mongodb-memory-server downloads a mongod binary on first run
    hookTimeout: 120_000,
    testTimeout: 30_000,
    include: ["tests/**/*.test.ts"],
  },
});
