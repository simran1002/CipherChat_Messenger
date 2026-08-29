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

/**
 * Proxied requests are same-origin from the app's point of view, so the
 * browser's Origin header (which names the Vite port) must not reach the
 * backend's CORS allowlist — strip it. This makes ANY VITE_PORT work with no
 * backend config, and CORS stays enforced for genuinely cross-origin callers.
 */
import type { ProxyOptions } from "vite";

const stripOrigin: NonNullable<ProxyOptions["configure"]> = (proxy) => {
  proxy.on("proxyReq", (proxyReq) => proxyReq.removeHeader("origin"));
  proxy.on("proxyReqWs", (proxyReq) => proxyReq.removeHeader("origin"));
};

export default defineConfig({
  plugins: [react()],
  server: {
    // VITE_PORT: run alongside other projects that own :3000 (pairs with
    // VITE_DEV_API_TARGET for a backend on a non-default port)
    port: Number(process.env.VITE_PORT) || 3000,
    proxy: {
      ...Object.fromEntries(
        API_PREFIXES.map((p) => [p, { target: API_TARGET, changeOrigin: true, configure: stripOrigin }])
      ),
      "/socket.io": { target: API_TARGET, changeOrigin: true, ws: true, configure: stripOrigin },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      output: {
        // Long-lived vendor chunks: app-code edits no longer bust the cached
        // React/motion bytes (they dominated the entry chunk)
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-motion": ["framer-motion"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/setupTests.ts"],
  },
});
