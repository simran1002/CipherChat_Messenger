import { User } from "../models/User.js";
import { heartbeat, metrics, presenceRegistry, rateLimiter, typingMgr } from "../shared/index.js";
import { RosterBroadcaster } from "../shared/RosterBroadcaster.js";
import { socketsConnected } from "../shared/prometheus.js";
import { errMessage, logger } from "../utils/logger.js";
import type { AppServer, AppSocket, RosterPayload } from "./events.js";

/** Roster entries per broadcast — the payload stays O(1) as the org grows. */
export const ROSTER_CAP = 100;

export async function rosterPayload(): Promise<RosterPayload> {
  const users = await presenceRegistry.list();
  return { total: users.length, users: users.slice(0, ROSTER_CAP) };
}

// One throttle per process; the io reference tracks the latest server so the
// coalesced trailing broadcast always goes to the live instance.
let ioRef: AppServer | null = null;
const rosterBroadcaster = new RosterBroadcaster(async () => {
  if (ioRef) ioRef.emit("onlineUsers", await rosterPayload());
});

/**
 * Request a roster broadcast. Immediate when idle; any burst of joins,
 * leaves, or presence changes inside the cooldown collapses into one
 * trailing broadcast (see RosterBroadcaster for the measured rationale).
 */
export function broadcastOnlineUsers(io: AppServer): void {
  ioRef = io;
  rosterBroadcaster.request();
}

/** Connect-time bookkeeping: mark online, register presence, arm heartbeat. */
/** Mark the user online in the DB + roster and tell everyone. */
async function registerPresence(io: AppServer, socket: AppSocket): Promise<void> {
  const userId = socket.data.userId;
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
      broadcastOnlineUsers(io);
    }
  } catch (err) {
    logger.error("Error registering presence", { error: errMessage(err) });
  }
}

/** (Re)arm the liveness timer — auto-offline if the client stops pinging (~60s). */
function armHeartbeat(io: AppServer, userId: string): void {
  heartbeat.beat(userId, async (staleUserId) => {
    logger.info("Heartbeat timeout — marking offline", { userId: staleUserId });
    await presenceRegistry.delete(staleUserId);
    broadcastOnlineUsers(io);
    try {
      await User.findByIdAndUpdate(staleUserId, { isOnline: false, lastSeen: new Date() });
    } catch {
      /* best-effort */
    }
  });
}

/** Connect-time bookkeeping: mark online, register presence, arm heartbeat. */
export async function handleConnect(io: AppServer, socket: AppSocket): Promise<void> {
  logger.info("Socket connected", { userId: socket.data.userId });
  metrics.userConnected();
  socketsConnected.inc();
  await registerPresence(io, socket);
  armHeartbeat(io, socket.data.userId);
}

export function registerPresenceHandlers(io: AppServer, socket: AppSocket): void {
  const userId = socket.data.userId;

  socket.on("heartbeat", async () => {
    // Self-heal: a socket that was timed out of the roster (client paused,
    // laptop slept) but is still connected re-registers on its next ping
    // instead of staying invisible until it reconnects.
    if (!(await presenceRegistry.get(userId))) {
      await registerPresence(io, socket);
      armHeartbeat(io, userId);
    } else {
      heartbeat.refresh(userId);
      // Refresh the Redis presence TTL (safety net if this pod dies uncleanly)
      void presenceRegistry.touch(userId);
    }
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
      broadcastOnlineUsers(io);
    }
  });

  socket.on("disconnect", async () => {
    logger.info("Socket disconnected", { userId });
    heartbeat.clear(userId);
    void typingMgr.clearUser(userId);
    await rateLimiter.clear(userId);
    metrics.userDisconnected();
    socketsConnected.dec();
    await presenceRegistry.delete(userId);
    broadcastOnlineUsers(io);
    // lastSeen bookkeeping is best-effort — never serialize mass disconnects
    // (a dying pod's 10k sockets) behind per-user DB round-trips
    void User.findByIdAndUpdate(userId, { isOnline: false, lastSeen: new Date() }).catch(() => {});
  });
}
