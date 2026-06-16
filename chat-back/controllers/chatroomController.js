const mongoose = require("mongoose");
const Chatroom = mongoose.model("Chatroom");
const Message = mongoose.model("Message");
const logger = require("../utils/logger");

exports.createChatroom = async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) throw "Chatroom name is required.";
  const nameRegex = /^[A-Za-z0-9\s\-_]+$/;
  if (!nameRegex.test(name))
    throw "Chatroom name can only contain letters, numbers, spaces, hyphens, and underscores.";
  if (name.trim().length > 50) throw "Chatroom name cannot exceed 50 characters.";
  const chatroomExists = await Chatroom.findOne({
    name: { $regex: new RegExp(`^${name.trim()}$`, "i") },
  });
  if (chatroomExists) throw "Chatroom with that name already exists!";
  const chatroom = new Chatroom({ name: name.trim(), createdBy: req.payload.id });
  await chatroom.save();
  res.json({ message: "Chatroom created!", chatroom });
};

exports.getAllChatrooms = async (req, res) => {
  const chatrooms = await Chatroom.find({})
    .populate("createdBy", "name")
    .sort({ createdAt: -1 });
  res.json(chatrooms);
};

exports.getChatroomMessages = async (req, res) => {
  const { chatroomId } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const skip = (page - 1) * limit;

  if (!mongoose.Types.ObjectId.isValid(chatroomId)) throw "Invalid chatroom ID.";
  const chatroom = await Chatroom.findById(chatroomId);
  if (!chatroom) throw "Chatroom not found.";

  const messages = await Message.find({ chatroom: chatroomId })
    .populate("user", "name email dp")
    .sort({ createdAt: 1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const total = await Message.countDocuments({ chatroom: chatroomId });

  res.json({
    messages,
    chatroom: { name: chatroom.name, id: chatroom._id },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

exports.editMessage = async (req, res) => {
  const { messageId } = req.params;
  const { message } = req.body;
  if (!message || !message.trim()) throw "Message content is required.";
  if (message.length > 2000) throw "Message cannot exceed 2000 characters.";
  if (!mongoose.Types.ObjectId.isValid(messageId)) throw "Invalid message ID.";
  const msg = await Message.findById(messageId);
  if (!msg) throw "Message not found.";
  if (msg.user.toString() !== req.payload.id) throw "You can only edit your own messages.";
  msg.message = message.trim();
  msg.edited = true;
  await msg.save();
  logger.info("Message edited", { messageId, userId: req.payload.id });
  res.json({ message: "Message updated.", updatedMessage: msg });
};

exports.deleteMessage = async (req, res) => {
  const { messageId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(messageId)) throw "Invalid message ID.";
  const msg = await Message.findById(messageId);
  if (!msg) throw "Message not found.";
  if (msg.user.toString() !== req.payload.id) throw "You can only delete your own messages.";
  await msg.deleteOne();
  logger.info("Message deleted", { messageId, userId: req.payload.id });
  res.json({ message: "Message deleted.", messageId });
};

exports.pinMessage = async (req, res) => {
  const { messageId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(messageId)) throw "Invalid message ID.";
  const msg = await Message.findById(messageId);
  if (!msg) throw "Message not found.";
  msg.pinned = !msg.pinned;
  await msg.save();
  res.json({ message: msg.pinned ? "Message pinned." : "Message unpinned.", pinned: msg.pinned, messageId });
};

exports.getPinnedMessages = async (req, res) => {
  const { chatroomId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(chatroomId)) throw "Invalid chatroom ID.";
  const messages = await Message.find({ chatroom: chatroomId, pinned: true })
    .populate("user", "name dp")
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
  res.json(messages);
};

exports.searchMessages = async (req, res) => {
  const { chatroomId } = req.params;
  const { q } = req.query;
  if (!mongoose.Types.ObjectId.isValid(chatroomId)) throw "Invalid chatroom ID.";
  if (!q || !q.trim()) throw "Search query is required.";
  const messages = await Message.find({
    chatroom: chatroomId,
    message: { $regex: q.trim(), $options: "i" },
  })
    .populate("user", "name dp")
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  res.json({ messages, query: q.trim() });
};

exports.toggleReaction = async (req, res) => {
  const { messageId } = req.params;
  const { emoji } = req.body;
  const userId = req.payload.id;
  const userName = req.payload.name || "";

  if (!mongoose.Types.ObjectId.isValid(messageId)) throw "Invalid message ID.";
  if (!emoji) throw "Emoji is required.";

  const msg = await Message.findById(messageId);
  if (!msg) throw "Message not found.";

  const existing = msg.reactions.find(
    (r) => r.emoji === emoji && r.user.toString() === userId
  );
  if (existing) {
    msg.reactions = msg.reactions.filter(
      (r) => !(r.emoji === emoji && r.user.toString() === userId)
    );
  } else {
    msg.reactions.push({ emoji, user: userId, name: userName });
  }

  await msg.save();
  res.json({ reactions: msg.reactions, messageId });
};

// Mark all messages in a room as read by this user (up to and including the latest)
exports.markRead = async (req, res) => {
  const { chatroomId } = req.params;
  const userId = req.payload.id;
  const { upToSequence } = req.body; // optional — defaults to all

  if (!mongoose.Types.ObjectId.isValid(chatroomId)) throw "Invalid chatroom ID.";

  const filter = {
    chatroom: chatroomId,
    user: { $ne: userId },       // don't mark own messages as "read by me"
    "readBy.user": { $ne: userId },
  };
  if (upToSequence) filter.sequenceNumber = { $lte: upToSequence };

  const result = await Message.updateMany(filter, {
    $push: { readBy: { user: userId, readAt: new Date() } },
  });

  res.json({ marked: result.modifiedCount });
};

// Confirm a single message was delivered to this device
exports.markDelivered = async (req, res) => {
  const { messageId } = req.params;
  const userId = req.payload.id;

  if (!mongoose.Types.ObjectId.isValid(messageId)) throw "Invalid message ID.";

  await Message.updateOne(
    { _id: messageId, deliveredTo: { $ne: userId } },
    { $push: { deliveredTo: userId } }
  );

  res.json({ ok: true });
};
