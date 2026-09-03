# Node 22 (current LTS) — a transitive dep (otplib -> @noble/hashes) declares
# engines.node >= 20.19.0; node:20-alpine is a moving tag that can resolve
# below that floor. Pinned to the major that satisfies every engine range in
# the dependency tree rather than chasing a specific 20.x patch.

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Production dependencies only ─────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Run as the unprivileged node user; uploads dir must be writable by it
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p uploads && chown -R node:node /app
USER node

EXPOSE 8000

# /health returns 503 until Mongo is reachable — the orchestrator gates traffic on it
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
