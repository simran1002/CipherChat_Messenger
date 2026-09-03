# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Baked at build time — Vite inlines these into the bundle
ARG VITE_API_URL=http://localhost:8000
ENV VITE_API_URL=$VITE_API_URL
# "websocket" for the least_conn LB profile (no polling → no sticky sessions)
ARG VITE_SOCKET_TRANSPORTS=websocket,polling
ENV VITE_SOCKET_TRANSPORTS=$VITE_SOCKET_TRANSPORTS
RUN npm run build

# ── Runtime: static files behind nginx ────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q --spider http://127.0.0.1/ || exit 1
