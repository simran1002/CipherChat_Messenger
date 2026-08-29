import mongoose from "mongoose";
import { Message } from "../models/Message.js";
import { RoomReadState } from "../models/RoomReadState.js";
import { canAccessRoom, ensureMembership, getAccessibleRoomSummary } from "../services/roomAccess.js";
import { senderInfo } from "../services/userInfo.js";
import { dedup, metrics, presenceRegistry, rateLimiter, seqCounter, typingMgr } from "../shared/index.js";
import { messageLatency, messagesTotal } from "../shared/prometheus.js";
import { errMessage, logger } from "../utils/logger.js";
import type { AppServer, AppSocket, ChatroomMessagePayload, NewMessagePayload } from "./events.js";

const MAX_MENTIONS = 10;

export function registerRoomHandlers(io: AppServer, socket: AppSocket): void {
  const userId = socket.data.userId;

  socket.on("joinRoom", async ({ chatroomId }) => {
    // Private rooms admit members only (this was previously unchecked);
    // joining a public room records participation.
    if (!(await canAccessRoom(chatroomId, userId))) return;
    await ensureMembership(chatroomId, userId).catch(() => {});
    socket.join(chatroomId);
    const u = await presenceRegistry.get(userId);
    if (u) socket.to(chatroomId).emit("userJoined", { userId, name: u.name });
    // A page that mounts after the socket connected missed the connect-time
    // roster broadcast — hand this socket the current roster directly.
    socket.emit("onlineUsers", await presenceRegistry.list());
  });

  socket.on("leaveRoom", ({ chatroomId }) => {
    socket.leave(chatroomId);
    typingMgr.stop(chatroomId, userId);
  });

  // ── Text message — ACK + dedup + sequence + rate limit ────────────────────
  socket.on("chatroomMessage", async (data: ChatroomMessagePayload, ackFn) => {
    const { chatroomId, message, replyTo, expiresIn, clientMessageId } = data;
    const sendTs = Date.now();

    // Token-bucket rate limit
    if (!(await rateLimiter.allow(userId))) {
      metrics.recordRateLimit();
      messagesTotal.inc({ outcome: "rate_limited" });
      const err = { error: "rate_limited" as const, message: "Slow down — too many messages." };
      if (typeof ackFn === "function") ackFn({ ok: false, ...err });
      else socket.emit("messageError", err);
      return;
    }

    // Idempotency — reject duplicates, ACK with original id
    if (clientMessageId) {
      const existing = await dedup.check(clientMessageId);
      if (existing) {
        metrics.recordDuplicate();
        messagesTotal.inc({ outcome: "duplicate" });
        if (typeof ackFn === "function") ackFn({ ok: true, messageId: existing, duplicate: true });
        return;
      }
    }

    try {
      if (!message || !message.trim() || message.length > 2000) {
        if (typeof ackFn === "function") ackFn({ ok: false, error: "invalid_message" });
        return;
      }

      // Room-level authorization — cached summary (15s TTL): the send path
      // used to fetch the full room doc from Mongo for every message
      const room = await getAccessibleRoomSummary(chatroomId, userId);
      if (!room) {
        if (typeof ackFn === "function") ackFn({ ok: false, error: "forbidden" });
        return;
      }

      // Sending is participation — record membership for public-room senders
      // who never emitted joinRoom. Idempotent, off the latency path.
      if (!room.members.some((m) => m.user === userId)) {
        void ensureMembership(chatroomId, userId).catch(() => {});
      }

      const user = await senderInfo(userId);
      if (!user) return;

      // Sanitize mentions: valid ids, deduped, capped, never yourself. In a
      // private room only members can be mentioned (non-members can't read).
      const mentions = [...new Set(data.mentions ?? [])]
        .filter((id) => mongoose.Types.ObjectId.isValid(id) && id !== userId)
        .filter((id) => !room.isPrivate || room.members.some((m) => m.user === id))
        .slice(0, MAX_MENTIONS);

      const seq = await seqCounter.next(chatroomId);

      const msgData: Record<string, unknown> = {
        chatroom: chatroomId,
        user: userId,
        message: message.trim(),
        type: "text",
        sequenceNumber: seq,
        clientMessageId: clientMessageId || null,
        deliveredTo: [userId],
        mentions,
      };

      if (replyTo?.messageId) {
        msgData.replyTo = {
          messageId: replyTo.messageId,
          preview: replyTo.preview || "",
          senderName: replyTo.senderName || "",
        };
      }

      if (expiresIn && Number.isInteger(expiresIn) && expiresIn > 0) {
        msgData.expiresAt = new Date(Date.now() + expiresIn * 1000);
      }

      const newMessage = new Message(msgData);
      await newMessage.save();

      if (clientMessageId) await dedup.mark(clientMessageId, newMessage._id.toString());

      metrics.recordSent();
      metrics.recordLatency(Date.now() - sendTs);
      messagesTotal.inc({ outcome: "sent" });
      messageLatency.observe(Date.now() - sendTs);

      const payload: NewMessagePayload = {
        _id: newMessage._id.toString(),
        mentions,
        type: "text",
        message: message.trim(),
        name: user.name,
        userId,
        dp: user.dp || "",
        edited: false,
        reactions: [],
        replyTo: newMessage.replyTo ?? null,
        expiresAt: newMessage.expiresAt ?? null,
        sequenceNumber: seq,
        clientMessageId: clientMessageId || null,
        deliveryStatus: "sent",
        createdAt: newMessage.createdAt,
      };

      // ACK sender first (at-least-once guarantee — client retries until this fires)
      if (typeof ackFn === "function") {
        ackFn({ ok: true, messageId: newMessage._id.toString(), sequenceNumber: seq });
      }

      io.to(chatroomId).emit("newMessage", payload);
      metrics.recordDelivered();

      // Sending implies having read everything up to your own message —
      // fire-and-forget: badge bookkeeping must not sit on the send path
      void RoomReadState.updateOne(
        { user: userId, chatroom: chatroomId },
        { $max: { lastReadSequence: seq } },
        { upsert: true }
      ).catch(() => {});

      // Targeted mention notifications via per-user rooms (cross-replica safe)
      for (const mentionedId of mentions) {
        io.to(`user:${mentionedId}`).emit("mentionNotification", {
          chatroomId,
          chatroomName: room.name,
          messageId: newMessage._id.toString(),
          from: user.name,
          preview: message.trim().slice(0, 80),
        });
      }
    } catch (err) {
      metrics.recordFailed();
      messagesTotal.inc({ outcome: "failed" });
      logger.error("Error sending message", { error: errMessage(err) });
      if (typeof ackFn === "function") ackFn({ ok: false, error: "server_error" });
      else socket.emit("messageError", { message: "Failed to send message" });
    }
  });

  // ── File / audio / location message ───────────────────────────────────────
  socket.on("chatroomFileMessage", async (data) => {
    const { chatroomId, type, fileUrl, fileName, mimeType, fileSize, lat, lng, replyTo, clientMessageId } = data;
    try {
      // File messages get the same rate limit as text (was previously unlimited)
      if (!(await rateLimiter.allow(userId))) {
        metrics.recordRateLimit();
        return;
      }
      if (clientMessageId && (await dedup.check(clientMessageId))) return;
      if (!(await getAccessibleRoomSummary(chatroomId, userId))) return;

      const user = await senderInfo(userId);
      if (!user) return;

      const seq = await seqCounter.next(chatroomId);
      const msgData: Record<string, unknown> = {
        chatroom: chatroomId,
        user: userId,
        type: type || "file",
        message: fileName || (type === "location" ? "📍 Location" : "File"),
        fileUrl: fileUrl || "",
        fileName: fileName || "",
        mimeType: mimeType || "",
        fileSize: fileSize || 0,
        lat: lat ?? null,
        lng: lng ?? null,
        sequenceNumber: seq,
        clientMessageId: clientMessageId || null,
        deliveredTo: [userId],
      };

      if (replyTo?.messageId) {
        msgData.replyTo = { messageId: replyTo.messageId, preview: replyTo.preview || "", senderName: replyTo.senderName || "" };
      }

      const newMessage = new Message(msgData);
      await newMessage.save();

      if (clientMessageId) await dedup.mark(clientMessageId, newMessage._id.toString());
      metrics.recordSent();
      metrics.recordDelivered();

      io.to(chatroomId).emit("newMessage", {
        _id: newMessage._id.toString(),
        type: newMessage.type ?? "file",
        message: newMessage.message ?? "",
        fileUrl: newMessage.fileUrl ?? "",
        fileName: newMessage.fileName ?? "",
        mimeType: newMessage.mimeType ?? "",
        fileSize: newMessage.fileSize ?? 0,
        lat: newMessage.lat ?? null,
        lng: newMessage.lng ?? null,
        name: user.name,
        userId,
        dp: user.dp || "",
        reactions: [],
        replyTo: newMessage.replyTo ?? null,
        sequenceNumber: seq,
        deliveryStatus: "sent",
        createdAt: newMessage.createdAt,
      });
    } catch (err) {
      logger.error("Error sending file message", { error: errMessage(err) });
    }
  });

  // ── Reactions / edits / deletes / pins ────────────────────────────────────
  // These relays fan out changes already persisted via REST. Edit/delete now
  // verify ownership server-side instead of trusting the client blindly.
  socket.on("reactionToggled", ({ chatroomId, messageId, reactions }) => {
    if (!mongoose.Types.ObjectId.isValid(messageId) || !Array.isArray(reactions)) return;
    socket.to(chatroomId).emit("reactionUpdated", { messageId, reactions });
  });

  socket.on("messageEdited", async ({ chatroomId, messageId, newText }) => {
    if (!mongoose.Types.ObjectId.isValid(messageId)) return;
    if (typeof newText !== "string" || !newText.trim() || newText.length > 2000) return;
    const owned = await Message.exists({ _id: messageId, user: userId });
    if (!owned) return;
    socket.to(chatroomId).emit("messageEdited", { messageId, newText });
  });

  socket.on("messageDeleted", async ({ chatroomId, messageId }) => {
    if (!mongoose.Types.ObjectId.isValid(messageId)) return;
    // REST already deleted the doc when this relay fires, so existence can't
    // be checked — but only relay ids that are structurally valid.
    socket.to(chatroomId).emit("messageDeleted", { messageId });
  });

  socket.on("messagePinned", async ({ chatroomId, messageId, pinned }) => {
    if (!mongoose.Types.ObjectId.isValid(messageId)) return;
    socket.to(chatroomId).emit("messagePinned", { messageId, pinned: Boolean(pinned) });
  });

  // ── Typing — TTL-managed, no ghost indicators ─────────────────────────────
  socket.on("typing", async ({ chatroomId }) => {
    // The presence entry is written asynchronously on connect; a typing event
    // that races it (fast clients, busy pods) must not be silently dropped.
    const name = (await senderInfo(userId))?.name;
    if (!name) return;
    typingMgr.start(chatroomId, userId, name, (expiredId) => {
      socket.to(chatroomId).emit("userStopTyping", { userId: expiredId, chatroomId });
    });
    socket.to(chatroomId).emit("userTyping", { userId, name, chatroomId });
  });

  socket.on("stopTyping", ({ chatroomId }) => {
    typingMgr.stop(chatroomId, userId);
    socket.to(chatroomId).emit("userStopTyping", { userId, chatroomId });
  });
}
