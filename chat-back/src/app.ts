import express from "express";
import path from "node:path";
import { hostname } from "node:os";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import RedisStore from "rate-limit-redis";
import { env } from "./config/env.js";
import { getRedis, redisEnabled } from "./config/redis.js";
import { registry } from "./shared/prometheus.js";
import { errorHandler, notFound } from "./middlewares/errorHandlers.js";
import userRoutes from "./routes/user.js";
import chatroomRoutes from "./routes/chatroom.js";
import directMessageRoutes from "./routes/directMessage.js";
import uploadRoutes from "./routes/upload.js";
import aiRoutes from "./routes/ai.js";
import presenceRoutes from "./routes/presence.js";
import analyticsRoutes from "./routes/analytics.js";
import keysRoutes from "./routes/keys.js";

/** Shared between HTTP CORS and the Socket.IO server (they used to diverge). */
export const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
  // 127.0.0.1 is a *different origin* from localhost → separate localStorage
  // and IndexedDB. Opening the app on both gives two fully isolated users in
  // one browser profile — handy for E2EE / failover demos without incognito.
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  env.FRONTEND_URL,
].filter((o): o is string => Boolean(o));

const app = express();

// Behind nginx/compose in later phases — trust the first proxy hop so
// express-rate-limit sees real client IPs.
app.set("trust proxy", 1);

app.use(
  helmet({
    // /uploads images are consumed cross-origin by the frontend dev server
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// With Redis, HTTP rate-limit counters are shared across replicas — otherwise
// N pods would multiply every limit by N.
function limiterStore(prefix: string) {
  return redisEnabled
    ? new RedisStore({
        prefix: `rl:${prefix}:`,
        sendCommand: (...args: string[]) => getRedis().call(args[0]!, ...args.slice(1)) as never,
      })
    : undefined;
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: limiterStore("user"),
  message: { message: "Too many requests, please try again later." },
});
app.use("/user", authLimiter);

// Refresh gets its own, tighter bucket on top of the /user one: a stolen or
// guessed refresh cookie shouldn't get 100 tries per window.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: limiterStore("refresh"),
  message: { message: "Too many refresh attempts, please sign in again." },
});
app.use("/user/refresh", refreshLimiter);

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: limiterStore("upload"),
  message: { message: "Too many uploads, please slow down." },
});
app.use("/upload", uploadLimiter);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

// Prometheus scrape target. Content-free (counts/latencies only) — intended
// for the private network; in production, restrict at the ingress/LB layer.
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", registry.contentType);
  res.send(await registry.metrics());
});

app.get("/health", (_req, res) => {
  const mongoUp = mongoose.connection.readyState === 1;
  res.status(mongoUp ? 200 : 503).json({
    status: mongoUp ? "ok" : "degraded",
    mongo: mongoUp ? "connected" : mongoose.STATES[mongoose.connection.readyState],
    // Which replica answered — behind an ip_hash LB this is also the pod that
    // owns this client's sockets (same client IP → same upstream). The
    // failover verifier uses it to target the right pod.
    pod: hostname(),
    timestamp: new Date().toISOString(),
  });
});

// Serve uploaded files statically (local storage driver only — with the S3
// driver, URLs point at the bucket/CDN and this route simply 404s)
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

app.use("/user", userRoutes);
app.use("/chatroom", chatroomRoutes);
app.use("/dm", directMessageRoutes);
app.use("/upload", uploadRoutes);
app.use("/ai", aiRoutes);
app.use("/presence", presenceRoutes);
app.use("/analytics", analyticsRoutes);
app.use("/keys", keysRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
