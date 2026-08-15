import express from "express";
import path from "node:path";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import { env } from "./config/env.js";
import { errorHandler, notFound } from "./middlewares/errorHandlers.js";
import userRoutes from "./routes/user.js";
import chatroomRoutes from "./routes/chatroom.js";
import directMessageRoutes from "./routes/directMessage.js";
import uploadRoutes from "./routes/upload.js";
import aiRoutes from "./routes/ai.js";
import presenceRoutes from "./routes/presence.js";
import analyticsRoutes from "./routes/analytics.js";

/** Shared between HTTP CORS and the Socket.IO server (they used to diverge). */
export const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
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

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
});
app.use("/user", authLimiter);

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
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

app.get("/health", (_req, res) => {
  const mongoUp = mongoose.connection.readyState === 1;
  res.status(mongoUp ? 200 : 503).json({
    status: mongoUp ? "ok" : "degraded",
    mongo: mongoUp ? "connected" : mongoose.STATES[mongoose.connection.readyState],
    timestamp: new Date().toISOString(),
  });
});

// Serve uploaded files statically
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

app.use("/user", userRoutes);
app.use("/chatroom", chatroomRoutes);
app.use("/dm", directMessageRoutes);
app.use("/upload", uploadRoutes);
app.use("/ai", aiRoutes);
app.use("/presence", presenceRoutes);
app.use("/analytics", analyticsRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
