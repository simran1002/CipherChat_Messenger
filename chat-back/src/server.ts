import mongoose from "mongoose";
import { env } from "./config/env.js";
import { errMessage, logger } from "./utils/logger.js";

// Register models before anything else touches mongoose.model()
import "./models/User.js";
import "./models/Chatroom.js";
import "./models/Message.js";
import "./models/DirectMessage.js";
import "./models/DMMessage.js";
import "./models/RefreshToken.js";

import app, { allowedOrigins } from "./app.js";
import { createSocketServer } from "./sockets/index.js";
import { stopSharedModules } from "./shared/index.js";
import { closeRedis } from "./config/redis.js";

const MONGO_RETRY_DELAY_MS = 3000;
const MONGO_MAX_ATTEMPTS = 5;

async function connectMongo(): Promise<void> {
  for (let attempt = 1; attempt <= MONGO_MAX_ATTEMPTS; attempt++) {
    try {
      await mongoose.connect(env.DATABASE, { serverSelectionTimeoutMS: 5000 });
      logger.info("MongoDB connected");
      return;
    } catch (err) {
      logger.error("MongoDB connection failed", {
        attempt,
        maxAttempts: MONGO_MAX_ATTEMPTS,
        error: errMessage(err),
      });
      if (attempt === MONGO_MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, MONGO_RETRY_DELAY_MS));
    }
  }
}

async function main(): Promise<void> {
  await connectMongo();

  mongoose.connection.on("error", (err) =>
    logger.error("Mongoose connection error", { error: errMessage(err) })
  );

  const server = app.listen(env.PORT, () => {
    logger.info("Server listening", { port: env.PORT, env: env.ENV });
  });

  const io = createSocketServer(server, allowedOrigins);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  // Rolling deploys used to kill in-flight sockets with no cleanup, leaving
  // stale isOnline:true rows behind forever.
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });

    const forceExit = setTimeout(() => {
      logger.error("Forced exit after shutdown timeout");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      await io.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
      stopSharedModules();
      await closeRedis();
      await mongoose.disconnect();
      logger.info("Shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error("Error during shutdown", { error: errMessage(err) });
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: errMessage(err) });
  process.exit(1);
});
