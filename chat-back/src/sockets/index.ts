import { Server } from "socket.io";
import type { Server as HttpServer } from "node:http";
import { verifyToken } from "../middlewares/auth.js";
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
    void handleConnect(io, socket);
    registerPresenceHandlers(io, socket);
    registerRoomHandlers(io, socket);
    registerDeliveryHandlers(io, socket);
    registerDmHandlers(io, socket);
  });

  logger.info("Socket.IO server initialized");
  return io;
}
