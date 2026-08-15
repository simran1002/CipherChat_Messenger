import { Message } from "../models/Message.js";
import { User } from "../models/User.js";
import { dedup, metrics, seqCounter } from "../shared/index.js";
import { errMessage, logger } from "../utils/logger.js";
import type { AppServer, AppSocket, SyncResultItem } from "./events.js";

const MAX_SYNC_BATCH = 50;

export function registerDeliveryHandlers(io: AppServer, socket: AppSocket): void {
  const userId = socket.data.userId;

  // ── Read receipts (batch) ─────────────────────────────────────────────────
  socket.on("markRead", async ({ chatroomId, upToSequence }) => {
    try {
      const filter: Record<string, unknown> = {
        chatroom: chatroomId,
        user: { $ne: userId },
        "readBy.user": { $ne: userId },
      };
      if (upToSequence) filter.sequenceNumber = { $lte: upToSequence };

      const result = await Message.updateMany(filter, {
        $push: { readBy: { user: userId, readAt: new Date() } },
      });

      if (result.modifiedCount > 0) {
        socket.to(chatroomId).emit("messagesRead", {
          userId,
          chatroomId,
          upToSequence: upToSequence ?? null,
          readAt: new Date(),
        });
      }
    } catch (err) {
      logger.error("markRead error", { error: errMessage(err) });
    }
  });

  // ── Delivery receipt (per-message) ────────────────────────────────────────
  socket.on("messageDelivered", async ({ messageId, chatroomId }) => {
    try {
      const result = await Message.findOneAndUpdate(
        { _id: messageId, deliveredTo: { $ne: userId } },
        { $push: { deliveredTo: userId } },
        { new: true, select: "deliveredTo" }
      );
      if (result) {
        socket.to(chatroomId).emit("messageDeliveryUpdate", {
          messageId,
          deliveredTo: result.deliveredTo.map((id) => id.toString()),
        });
      }
    } catch (err) {
      logger.debug("messageDelivered error", { error: errMessage(err) });
    }
  });

  // ── Offline queue sync — drain on reconnect ───────────────────────────────
  socket.on("syncOfflineQueue", async ({ messages }) => {
    if (!Array.isArray(messages) || !messages.length) return;
    const results: SyncResultItem[] = [];

    for (const item of messages.slice(0, MAX_SYNC_BATCH)) {
      const { chatroomId, message, clientMessageId } = item;
      if (!chatroomId || !message) continue;

      if (clientMessageId) {
        const existing = await dedup.check(clientMessageId);
        if (existing) {
          results.push({ clientMessageId, messageId: existing, duplicate: true });
          continue;
        }
      }

      try {
        const user = await User.findById(userId).select("name dp");
        if (!user) continue;
        const seq = await seqCounter.next(chatroomId);
        const newMessage = new Message({
          chatroom: chatroomId,
          user: userId,
          message: message.trim(),
          type: "text",
          sequenceNumber: seq,
          clientMessageId: clientMessageId || null,
          deliveredTo: [userId],
        });
        await newMessage.save();
        if (clientMessageId) await dedup.mark(clientMessageId, newMessage._id.toString());

        io.to(chatroomId).emit("newMessage", {
          _id: newMessage._id.toString(),
          type: "text",
          message: message.trim(),
          name: user.name,
          userId,
          dp: user.dp || "",
          sequenceNumber: seq,
          deliveryStatus: "sent",
          createdAt: newMessage.createdAt,
        });
        metrics.recordSent();
        results.push({ clientMessageId, messageId: newMessage._id.toString(), ok: true });
      } catch (err) {
        results.push({ clientMessageId, error: errMessage(err) });
      }
    }

    socket.emit("syncOfflineQueueResult", { results });
  });
}
