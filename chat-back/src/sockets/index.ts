import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import type { Server as HttpServer } from "node:http";
import { verifyToken } from "../middlewares/auth.js";
import { createRedisConnection, redisEnabled } from "../config/redis.js";
import { typingMgr } from "../shared/index.js";
import { logger } from "../utils/logger.js";
import type { AppServer } from "./events.js";
import { registerDeliveryHandlers } from "./deliveryHandlers.js";
import { registerDmHandlers } from "./dmHandlers.js";
import { handleConnect, registerPresenceHandlers } from "./presenceHandlers.js";
import { registerRoomHandlers } from "./roomHandlers.js";

export function createSocketServer(httpServer: HttpServer, allowedOrigins: string[]): AppServer {
  const io: AppServer = new Server(httpServer, {
    cors: {
      // Same allowlist as HTTP CORS — the old server reflected any origin here
      origin: allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // Redis adapter: room broadcasts fan out across every replica. Without it,
  // io.to(room) only reaches sockets on this process.
  if (redisEnabled) {
    const pubClient = createRedisConnection("socket-pub");
    const subClient = createRedisConnection("socket-sub");
    io.adapter(createAdapter(pubClient, subClient));
    logger.info("Socket.IO Redis adapter enabled");
  }

  // Typing expiry → stopTyping broadcast. Scope decides the fan-out:
  // "pod-local" = every pod heard the same Redis keyspace notification, so
  // each emits only to its own sockets (io.local) — the pods jointly cover
  // the room exactly once. "cluster" = only this instance saw the expiry
  // (in-memory timers / Redis fallback), so it broadcasts via the adapter.
  typingMgr.onExpire((chatroomId, userId, scope) => {
    const target = scope === "pod-local" ? io.local : io;
    target.to(chatroomId).emit("userStopTyping", { userId, chatroomId });
  });

  // ── Socket auth ─────────────────────────────────────────────────────────
  io.use((socket, next) => {
    try {
      // Preferred: socket.io auth payload (not logged by proxies).
      // Query-string fallback kept for old clients during the migration.
      const token =
        (socket.handshake.auth?.token as string | undefined) ??
        (socket.handshake.query.token as string | undefined);
      if (!token) return next(new Error("Authentication required"));
      socket.data.userId = verifyToken(token).id;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    // Per-user room: the cross-replica way to address "all of this user's
    // sockets" (replaces the old raw-socketId targeting that silently dropped
    // messages when sender and recipient landed on different pods).
    void socket.join(`user:${socket.data.userId}`);
    void handleConnect(io, socket);
    registerPresenceHandlers(io, socket);
    registerRoomHandlers(io, socket);
    registerDeliveryHandlers(io, socket);
    registerDmHandlers(io, socket);
  });

  logger.info("Socket.IO server initialized");
  return io;
}
