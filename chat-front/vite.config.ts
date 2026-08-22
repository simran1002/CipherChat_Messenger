/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev proxy: with no VITE_API_URL set, the app talks to its own origin and
 * Vite forwards API + Socket.IO traffic to the backend. No CORS in dev, no
 * .env needed for a fresh clone, and the two-origin demo trick
 * (localhost:3000 vs 127.0.0.1:3000) needs no allowlist at all. Production
 * builds bake an absolute VITE_API_URL (see chat-front/Dockerfile).
 */
const API_TARGET = process.env.VITE_DEV_API_TARGET || "http://localhost:8000";
const API_PREFIXES = [
  "/user", "/chatroom", "/dm", "/upload", "/uploads", "/ai", "/presence",
  "/analytics", "/keys", "/health", "/metrics",
];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      ...Object.fromEntries(API_PREFIXES.map((p) => [p, { target: API_TARGET, changeOrigin: true }])),
      "/socket.io": { target: API_TARGET, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/setupTests.ts"],
  },
});
