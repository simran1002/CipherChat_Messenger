require("dotenv").config();

const validateEnv = require("./utils/validateEnv");
validateEnv();

const logger = require("./utils/logger");
const mongoose = require("mongoose");

mongoose.connect(process.env.DATABASE);
mongoose.connection.on("error", (err) => logger.error("Mongoose connection error", { error: err.message }));
mongoose.connection.once("open", () => logger.info("MongoDB connected"));

require("./models/User");
require("./models/Chatroom");
require("./models/Message");
require("./models/DirectMessage");

const app = require("./app");
const PORT = process.env.PORT || 8000;
const server = app.listen(PORT, () => {
  logger.info("Server listening", { port: PORT, env: process.env.ENV || "production" });
});

const io = require("socket.io")(server, {
  allowEIO3: true,
  cors: { origin: true, methods: ["GET", "POST"], credentials: true },
});

const jwt = require("jwt-then");
const Message = mongoose.model("Message");
const User = mongoose.model("User");
const DirectMessage = mongoose.model("DirectMessage");

// ── Shared infrastructure modules ────────────────────────────────────────────
const dedup       = require("./shared/MessageDeduplicator");
const seqCounter  = require("./shared/SequenceCounter");
const typingMgr   = require("./shared/TypingStateManager");
const heartbeat   = require("./shared/PresenceHeartbeat");
const rateLimiter = require("./shared/RateLimiter");
const metrics     = require("./shared/MetricsCollector");

// userId → { socketId, name, email, dp, presenceStatus, presenceNote }
const onlineUsers = new Map();

// ── Socket auth ───────────────────────────────────────────────────────────────
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.query.token;
    if (!token) return next(new Error("Authentication required"));
    const payload = await jwt.verify(token, process.env.SECRET);
    socket.userId = payload.id;
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

// ── Connection ────────────────────────────────────────────────────────────────
io.on("connection", async (socket) => {
  logger.info("Socket connected", { userId: socket.userId });
  metrics.userConnected();

  try {
    const user = await User.findByIdAndUpdate(
      socket.userId,
      { isOnline: true },
      { new: true }
    ).select("name email dp presenceStatus presenceNote");

    if (user) {
      onlineUsers.set(socket.userId, {
        socketId: socket.id,
        name: user.name,
        email: user.email,
        dp: user.dp || "",
        presenceStatus: user.presenceStatus || "available",
        presenceNote: user.presenceNote || "",
      });
      io.emit("onlineUsers", buildOnlineList());
    }
  } catch (err) {
    logger.error("Error on connect", { error: err.message });
  }

  // Presence heartbeat — auto-offline if client stops pinging within 60s
  heartbeat.beat(socket.userId, async (userId) => {
    logger.info("Heartbeat timeout — marking offline", { userId });
    onlineUsers.delete(userId);
    io.emit("onlineUsers", buildOnlineList());
    try { await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen: new Date() }); } catch {}
  });

  // ── Heartbeat ping ────────────────────────────────────────────────────────
  socket.on("heartbeat", () => {
    heartbeat.refresh(socket.userId);
    socket.emit("heartbeatAck", { ts: Date.now() });
  });

  // ── Room membership ───────────────────────────────────────────────────────
  socket.on("joinRoom", ({ chatroomId }) => {
    socket.join(chatroomId);
    const u = onlineUsers.get(socket.userId);
    if (u) socket.to(chatroomId).emit("userJoined", { userId: socket.userId, name: u.name });
  });

  socket.on("leaveRoom", ({ chatroomId }) => {
    socket.leave(chatroomId);
    typingMgr.stop(chatroomId, socket.userId);
  });

  // ── Presence update ───────────────────────────────────────────────────────
  socket.on("presenceUpdate", ({ presenceStatus, presenceNote }) => {
    const u = onlineUsers.get(socket.userId);
    if (u) {
      onlineUsers.set(socket.userId, { ...u, presenceStatus, presenceNote });
      io.emit("onlineUsers", buildOnlineList());
    }
  });

  // ── Text message — ACK + dedup + sequence + rate limit ───────────────────
  socket.on("chatroomMessage", async (data, ackFn) => {
    const { chatroomId, message, replyTo, expiresIn, clientMessageId } = data;
    const sendTs = Date.now();

    // Token-bucket rate limit
    if (!rateLimiter.allow(socket.userId)) {
      metrics.recordRateLimit();
      const err = { error: "rate_limited", message: "Slow down — too many messages." };
      if (typeof ackFn === "function") ackFn({ ok: false, ...err });
      else socket.emit("messageError", err);
      return;
    }

    // Idempotency — reject duplicates, ACK with original id
    if (clientMessageId) {
      const existing = dedup.check(clientMessageId);
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

      const user = await User.findById(socket.userId).select("name email dp");
      if (!user) return;

      const seq = seqCounter.next(chatroomId);

      const msgData = {
        chatroom: chatroomId,
        user: socket.userId,
        message: message.trim(),
        type: "text",
        sequenceNumber: seq,
        clientMessageId: clientMessageId || null,
        deliveredTo: [socket.userId],
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

      if (clientMessageId) dedup.mark(clientMessageId, newMessage._id.toString());

      metrics.recordSent();
      metrics.recordLatency(Date.now() - sendTs);

      const payload = {
        _id: newMessage._id,
        type: "text",
        message: message.trim(),
        name: user.name,
        userId: socket.userId,
        dp: user.dp || "",
        edited: false,
        reactions: [],
        replyTo: newMessage.replyTo || null,
        expiresAt: newMessage.expiresAt || null,
        sequenceNumber: seq,
        clientMessageId: clientMessageId || null,
        deliveryStatus: "sent",
        createdAt: newMessage.createdAt,
      };

      // ACK sender first (at-least-once guarantee — retry until this fires)
      if (typeof ackFn === "function") {
        ackFn({ ok: true, messageId: newMessage._id, sequenceNumber: seq });
      }

      io.to(chatroomId).emit("newMessage", payload);
      metrics.recordDelivered();

    } catch (err) {
      metrics.recordFailed();
      logger.error("Error sending message", { error: err.message });
      if (typeof ackFn === "function") ackFn({ ok: false, error: "server_error" });
      else socket.emit("messageError", { message: "Failed to send message" });
    }
  });

  // ── File / audio / location message ──────────────────────────────────────
  socket.on("chatroomFileMessage", async ({ chatroomId, type, fileUrl, fileName, mimeType, fileSize, lat, lng, replyTo, clientMessageId }) => {
    try {
      if (clientMessageId && dedup.check(clientMessageId)) return;

      const user = await User.findById(socket.userId).select("name email dp");
      if (!user) return;

      const seq = seqCounter.next(chatroomId);
      const msgData = {
        chatroom: chatroomId,
        user: socket.userId,
        type: type || "file",
        message: fileName || (type === "location" ? "📍 Location" : "File"),
        fileUrl: fileUrl || "",
        fileName: fileName || "",
        mimeType: mimeType || "",
        fileSize: fileSize || 0,
        lat: lat || null,
        lng: lng || null,
        sequenceNumber: seq,
        clientMessageId: clientMessageId || null,
        deliveredTo: [socket.userId],
      };

      if (replyTo?.messageId) {
        msgData.replyTo = { messageId: replyTo.messageId, preview: replyTo.preview || "", senderName: replyTo.senderName || "" };
      }

      const newMessage = new Message(msgData);
      await newMessage.save();

      if (clientMessageId) dedup.mark(clientMessageId, newMessage._id.toString());
      metrics.recordSent();
      metrics.recordDelivered();

      io.to(chatroomId).emit("newMessage", {
        _id: newMessage._id,
        type: newMessage.type,
        message: newMessage.message,
        fileUrl: newMessage.fileUrl,
        fileName: newMessage.fileName,
        mimeType: newMessage.mimeType,
        fileSize: newMessage.fileSize,
        lat: newMessage.lat,
        lng: newMessage.lng,
        name: user.name,
        userId: socket.userId,
        dp: user.dp || "",
        reactions: [],
        replyTo: newMessage.replyTo || null,
        sequenceNumber: seq,
        deliveryStatus: "sent",
        createdAt: newMessage.createdAt,
      });
    } catch (err) {
      logger.error("Error sending file message", { error: err.message });
    }
  });

  // ── Read receipts (batch, socket) ─────────────────────────────────────────
  socket.on("markRead", async ({ chatroomId, upToSequence }) => {
    try {
      const filter = {
        chatroom: chatroomId,
        user: { $ne: socket.userId },
        "readBy.user": { $ne: socket.userId },
      };
      if (upToSequence) filter.sequenceNumber = { $lte: upToSequence };

      const result = await Message.updateMany(filter, {
        $push: { readBy: { user: socket.userId, readAt: new Date() } },
      });

      if (result.modifiedCount > 0) {
        socket.to(chatroomId).emit("messagesRead", {
          userId: socket.userId,
          chatroomId,
          upToSequence: upToSequence || null,
          readAt: new Date(),
        });
      }
    } catch (err) {
      logger.error("markRead error", { error: err.message });
    }
  });

  // ── Delivery receipt (per-message) ────────────────────────────────────────
  socket.on("messageDelivered", async ({ messageId, chatroomId }) => {
    try {
      const result = await Message.findOneAndUpdate(
        { _id: messageId, deliveredTo: { $ne: socket.userId } },
        { $push: { deliveredTo: socket.userId } },
        { new: true, select: "deliveredTo" }
      );
      if (result) {
        socket.to(chatroomId).emit("messageDeliveryUpdate", {
          messageId,
          deliveredTo: result.deliveredTo,
        });
      }
    } catch {}
  });

  // ── Reactions / edits / deletes / pins (relay) ────────────────────────────
  socket.on("reactionToggled", ({ chatroomId, messageId, reactions }) => {
    socket.to(chatroomId).emit("reactionUpdated", { messageId, reactions });
  });

  socket.on("messageEdited", ({ chatroomId, messageId, newText }) => {
    socket.to(chatroomId).emit("messageEdited", { messageId, newText });
  });

  socket.on("messageDeleted", ({ chatroomId, messageId }) => {
    socket.to(chatroomId).emit("messageDeleted", { messageId });
  });

  socket.on("messagePinned", ({ chatroomId, messageId, pinned }) => {
    socket.to(chatroomId).emit("messagePinned", { messageId, pinned });
  });

  // ── Typing — TTL-managed, no ghost indicators ─────────────────────────────
  socket.on("typing", ({ chatroomId }) => {
    const u = onlineUsers.get(socket.userId);
    if (!u) return;
    typingMgr.start(chatroomId, socket.userId, u.name, (expiredId) => {
      socket.to(chatroomId).emit("userStopTyping", { userId: expiredId, chatroomId });
    });
    socket.to(chatroomId).emit("userTyping", { userId: socket.userId, name: u.name, chatroomId });
  });

  socket.on("stopTyping", ({ chatroomId }) => {
    typingMgr.stop(chatroomId, socket.userId);
    socket.to(chatroomId).emit("userStopTyping", { userId: socket.userId, chatroomId });
  });

  // ── Direct Messages ───────────────────────────────────────────────────────
  socket.on("joinDM", ({ conversationId }) => socket.join(`dm:${conversationId}`));
  socket.on("leaveDM", ({ conversationId }) => socket.leave(`dm:${conversationId}`));

  socket.on("directMessage", async ({ conversationId, message }) => {
    try {
      if (!message || !message.trim() || message.length > 2000) return;
      const conv = await DirectMessage.findOne({ _id: conversationId, participants: socket.userId });
      if (!conv) return;

      const dmMsg = { user: socket.userId, message: message.trim(), createdAt: new Date() };
      conv.messages.push(dmMsg);
      conv.lastMessageAt = new Date();
      await conv.save();

      const savedMsg = conv.messages[conv.messages.length - 1];
      const user = onlineUsers.get(socket.userId);
      const payload = {
        _id: savedMsg._id,
        message: savedMsg.message,
        userId: socket.userId,
        name: user?.name || "Unknown",
        dp: user?.dp || "",
        createdAt: savedMsg.createdAt,
      };

      io.to(`dm:${conversationId}`).emit("newDirectMessage", { conversationId, ...payload });

      const otherId = conv.participants.find((p) => p.toString() !== socket.userId)?.toString();
      const otherInfo = onlineUsers.get(otherId);
      if (otherInfo) {
        io.to(otherInfo.socketId).emit("dmNotification", {
          conversationId,
          from: user?.name || "Someone",
          message: message.trim().slice(0, 80),
        });
      }
    } catch (err) {
      logger.error("Error sending DM", { error: err.message });
    }
  });

  socket.on("dmTyping", ({ conversationId }) => {
    const u = onlineUsers.get(socket.userId);
    if (u) socket.to(`dm:${conversationId}`).emit("dmUserTyping", { userId: socket.userId, name: u.name });
  });

  socket.on("dmStopTyping", ({ conversationId }) => {
    socket.to(`dm:${conversationId}`).emit("dmUserStopTyping", { userId: socket.userId });
  });

  // ── Offline queue sync — drain on reconnect ───────────────────────────────
  socket.on("syncOfflineQueue", async ({ messages }) => {
    if (!Array.isArray(messages) || !messages.length) return;
    const results = [];

    for (const item of messages.slice(0, 50)) {
      const { chatroomId, message, clientMessageId } = item;
      if (!chatroomId || !message) continue;

      if (clientMessageId) {
        const existing = dedup.check(clientMessageId);
        if (existing) { results.push({ clientMessageId, messageId: existing, duplicate: true }); continue; }
      }

      try {
        const user = await User.findById(socket.userId).select("name dp");
        const seq = seqCounter.next(chatroomId);
        const newMessage = new Message({
          chatroom: chatroomId,
          user: socket.userId,
          message: message.trim(),
          type: "text",
          sequenceNumber: seq,
          clientMessageId: clientMessageId || null,
          deliveredTo: [socket.userId],
        });
        await newMessage.save();
        if (clientMessageId) dedup.mark(clientMessageId, newMessage._id.toString());

        io.to(chatroomId).emit("newMessage", {
          _id: newMessage._id,
          type: "text",
          message: message.trim(),
          name: user.name,
          userId: socket.userId,
          dp: user.dp || "",
          sequenceNumber: seq,
          deliveryStatus: "sent",
          createdAt: newMessage.createdAt,
        });
        metrics.recordSent();
        results.push({ clientMessageId, messageId: newMessage._id, ok: true });
      } catch (err) {
        results.push({ clientMessageId, error: err.message });
      }
    }

    socket.emit("syncOfflineQueueResult", { results });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on("disconnect", async () => {
    logger.info("Socket disconnected", { userId: socket.userId });
    heartbeat.clear(socket.userId);
    typingMgr.clearUser(socket.userId);
    rateLimiter.clear(socket.userId);
    metrics.userDisconnected();
    onlineUsers.delete(socket.userId);
    io.emit("onlineUsers", buildOnlineList());
    try {
      await User.findByIdAndUpdate(socket.userId, { isOnline: false, lastSeen: new Date() });
    } catch {}
  });
});

function buildOnlineList() {
  return Array.from(onlineUsers.entries()).map(([id, u]) => ({
    userId: id,
    name: u.name,
    dp: u.dp,
    presenceStatus: u.presenceStatus || "available",
    presenceNote: u.presenceNote || "",
  }));
}
