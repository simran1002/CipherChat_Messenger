import { DirectMessage } from "../models/DirectMessage.js";
import { presenceRegistry } from "../shared/index.js";
import { errMessage, logger } from "../utils/logger.js";
import type { AppServer, AppSocket } from "./events.js";

export function registerDmHandlers(io: AppServer, socket: AppSocket): void {
  const userId = socket.data.userId;

  socket.on("joinDM", async ({ conversationId }) => {
    // Only participants may join a DM room (previously unchecked)
    const isParticipant = await DirectMessage.exists({ _id: conversationId, participants: userId });
    if (isParticipant) socket.join(`dm:${conversationId}`);
  });

  socket.on("leaveDM", ({ conversationId }) => {
    socket.leave(`dm:${conversationId}`);
  });

  socket.on("directMessage", async ({ conversationId, message }) => {
    try {
      if (!message || !message.trim() || message.length > 2000) return;
      const conv = await DirectMessage.findOne({ _id: conversationId, participants: userId });
      if (!conv) return;

      conv.messages.push({ user: userId, message: message.trim(), createdAt: new Date() } as never);
      conv.lastMessageAt = new Date();
      await conv.save();

      const savedMsg = conv.messages[conv.messages.length - 1];
      if (!savedMsg) return;
      const user = await presenceRegistry.get(userId);
      const payload = {
        _id: String(savedMsg._id),
        message: savedMsg.message,
        userId,
        name: user?.name || "Unknown",
        dp: user?.dp || "",
        createdAt: savedMsg.createdAt,
      };

      io.to(`dm:${conversationId}`).emit("newDirectMessage", { conversationId, ...payload });

      const otherId = conv.participants.find((p) => p.toString() !== userId)?.toString();
      if (otherId) {
        const otherInfo = await presenceRegistry.get(otherId);
        if (otherInfo) {
          io.to(otherInfo.socketId).emit("dmNotification", {
            conversationId,
            from: user?.name || "Someone",
            message: message.trim().slice(0, 80),
          });
        }
      }
    } catch (err) {
      logger.error("Error sending DM", { error: errMessage(err) });
    }
  });

  socket.on("dmTyping", async ({ conversationId }) => {
    const u = await presenceRegistry.get(userId);
    if (u) socket.to(`dm:${conversationId}`).emit("dmUserTyping", { userId, name: u.name });
  });

  socket.on("dmStopTyping", ({ conversationId }) => {
    socket.to(`dm:${conversationId}`).emit("dmUserStopTyping", { userId });
  });
}
