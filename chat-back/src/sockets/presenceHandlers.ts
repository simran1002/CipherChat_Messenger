import { User } from "../models/User.js";
import { heartbeat, metrics, presenceRegistry, rateLimiter, typingMgr } from "../shared/index.js";
import { socketsConnected } from "../shared/prometheus.js";
import { errMessage, logger } from "../utils/logger.js";
import type { AppServer, AppSocket } from "./events.js";

export async function broadcastOnlineUsers(io: AppServer): Promise<void> {
  io.emit("onlineUsers", await presenceRegistry.list());
}

/** Connect-time bookkeeping: mark online, register presence, arm heartbeat. */
export async function handleConnect(io: AppServer, socket: AppSocket): Promise<void> {
  const userId = socket.data.userId;
  logger.info("Socket connected", { userId });
  metrics.userConnected();
  socketsConnected.inc();

  try {
    const user = await User.findByIdAndUpdate(userId, { isOnline: true }, { new: true }).select(
      "name email dp presenceStatus presenceNote"
    );

    if (user) {
      await presenceRegistry.set(userId, {
        socketId: socket.id,
        name: user.name,
        email: user.email,
        dp: user.dp || "",
        presenceStatus: user.presenceStatus || "available",
        presenceNote: user.presenceNote || "",
      });
      await broadcastOnlineUsers(io);
    }
  } catch (err) {
    logger.error("Error on connect", { error: errMessage(err) });
  }

  // Presence heartbeat — auto-offline if the client stops pinging (~60s)
  heartbeat.beat(userId, async (staleUserId) => {
    logger.info("Heartbeat timeout — marking offline", { userId: staleUserId });
    await presenceRegistry.delete(staleUserId);
    await broadcastOnlineUsers(io);
    try {
      await User.findByIdAndUpdate(staleUserId, { isOnline: false, lastSeen: new Date() });
    } catch {
      /* best-effort */
    }
  });
}

export function registerPresenceHandlers(io: AppServer, socket: AppSocket): void {
  const userId = socket.data.userId;

  socket.on("heartbeat", () => {
    heartbeat.refresh(userId);
    // Refresh the Redis presence TTL (safety net if this pod dies uncleanly)
    void presenceRegistry.touch(userId);
    socket.emit("heartbeatAck", { ts: Date.now() });
  });

  socket.on("presenceUpdate", async ({ presenceStatus, presenceNote }) => {
    const updated = await presenceRegistry.update(userId, { presenceStatus, presenceNote });
    if (updated) {
      // Persist so the REST route and the socket path agree (they used to diverge)
      try {
        await User.findByIdAndUpdate(userId, { presenceStatus, presenceNote });
      } catch (err) {
        logger.debug("presenceUpdate persist failed", { error: errMessage(err) });
      }
      await broadcastOnlineUsers(io);
    }
  });

  socket.on("disconnect", async () => {
    logger.info("Socket disconnected", { userId });
    heartbeat.clear(userId);
    typingMgr.clearUser(userId);
    await rateLimiter.clear(userId);
    metrics.userDisconnected();
    socketsConnected.dec();
    await presenceRegistry.delete(userId);
    await broadcastOnlineUsers(io);
    try {
      await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen: new Date() });
    } catch {
      /* best-effort */
    }
  });
}
