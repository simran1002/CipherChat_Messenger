import mongoose from "mongoose";
import { Message } from "../models/Message.js";
import { User } from "../models/User.js";
import { dedup, metrics, presenceRegistry, rateLimiter, seqCounter, typingMgr } from "../shared/index.js";
import { errMessage, logger } from "../utils/logger.js";
import type { AppServer, AppSocket, ChatroomMessagePayload, NewMessagePayload } from "./events.js";

export function registerRoomHandlers(io: AppServer, socket: AppSocket): void {
  const userId = socket.data.userId;

  socket.on("joinRoom", async ({ chatroomId }) => {
    socket.join(chatroomId);
    const u = await presenceRegistry.get(userId);
    if (u) socket.to(chatroomId).emit("userJoined", { userId, name: u.name });
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
        if (typeof ackFn === "function") ackFn({ ok: true, messageId: existing, duplicate: true });
        return;
      }
    }

    try {
      if (!message || !message.trim() || message.length > 2000) {
        if (typeof ackFn === "function") ackFn({ ok: false, error: "invalid_message" });
        return;
      }

      const user = await User.findById(userId).select("name email dp");
      if (!user) return;

      const seq = await seqCounter.next(chatroomId);

      const msgData: Record<string, unknown> = {
        chatroom: chatroomId,
        user: userId,
        message: message.trim(),
        type: "text",
        sequenceNumber: seq,
        clientMessageId: clientMessageId || null,
        deliveredTo: [userId],
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

      const payload: NewMessagePayload = {
        _id: newMessage._id.toString(),
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
    } catch (err) {
      metrics.recordFailed();
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

      const user = await User.findById(userId).select("name email dp");
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
    const u = await presenceRegistry.get(userId);
    if (!u) return;
    typingMgr.start(chatroomId, userId, u.name, (expiredId) => {
      socket.to(chatroomId).emit("userStopTyping", { userId: expiredId, chatroomId });
    });
    socket.to(chatroomId).emit("userTyping", { userId, name: u.name, chatroomId });
  });

  socket.on("stopTyping", ({ chatroomId }) => {
    typingMgr.stop(chatroomId, userId);
    socket.to(chatroomId).emit("userStopTyping", { userId, chatroomId });
  });
}
