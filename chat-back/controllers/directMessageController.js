const mongoose = require("mongoose");
const DirectMessage = mongoose.model("DirectMessage");
const User = mongoose.model("User");
const logger = require("../utils/logger");

// GET /dm — list all conversations for the logged-in user
exports.getConversations = async (req, res) => {
  const userId = req.payload.id;

  const conversations = await DirectMessage.find({ participants: userId })
    .populate("participants", "name email dp")
    .sort({ lastMessageAt: -1 })
    .lean();

  const result = conversations.map((conv) => {
    const other = conv.participants.find((p) => p._id.toString() !== userId);
    const lastMsg = conv.messages[conv.messages.length - 1] || null;
    return {
      _id: conv._id,
      participant: other,
      lastMessage: lastMsg
        ? { message: lastMsg.message, createdAt: lastMsg.createdAt }
        : null,
      lastMessageAt: conv.lastMessageAt,
    };
  });

  res.json(result);
};

// GET /dm/:conversationId/messages — paginated messages
exports.getMessages = async (req, res) => {
  const { conversationId } = req.params;
  const userId = req.payload.id;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;

  if (!mongoose.Types.ObjectId.isValid(conversationId)) throw "Invalid conversation ID.";

  const conv = await DirectMessage.findOne({
    _id: conversationId,
    participants: userId,
  }).populate("participants", "name email dp");

  if (!conv) throw "Conversation not found.";

  const total = conv.messages.length;
  const start = Math.max(0, total - page * limit);
  const end = total - (page - 1) * limit;
  const messages = conv.messages.slice(start, end);

  const userMap = {};
  conv.participants.forEach((p) => { userMap[p._id.toString()] = p; });

  const other = conv.participants.find((p) => p._id.toString() !== userId);

  res.json({
    messages: messages.map((m) => ({
      _id: m._id,
      message: m.message,
      edited: m.edited,
      userId: m.user.toString(),
      user: userMap[m.user.toString()] || null,
      createdAt: m.createdAt,
    })),
    participant: other,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

// POST /dm/start — get or create a conversation with another user
exports.startConversation = async (req, res) => {
  const { targetUserId } = req.body;
  const userId = req.payload.id;

  if (!mongoose.Types.ObjectId.isValid(targetUserId)) throw "Invalid user ID.";
  if (targetUserId === userId) throw "Cannot start a conversation with yourself.";

  const targetUser = await User.findById(targetUserId).select("name email dp");
  if (!targetUser) throw "User not found.";

  let conv = await DirectMessage.findOne({
    participants: { $all: [userId, targetUserId], $size: 2 },
  }).populate("participants", "name email dp");

  if (!conv) {
    conv = new DirectMessage({ participants: [userId, targetUserId], messages: [] });
    await conv.save();
    conv = await conv.populate("participants", "name email dp");
    logger.info("DM conversation started", { userId, targetUserId });
  }

  const other = conv.participants.find((p) => p._id.toString() !== userId);
  res.json({ _id: conv._id, participant: other });
};

// GET /dm/users — list all users (for starting new DMs)
exports.getUsers = async (req, res) => {
  const userId = req.payload.id;
  const users = await User.find({ _id: { $ne: userId } })
    .select("name email dp")
    .sort({ name: 1 });
  res.json(users);
};
