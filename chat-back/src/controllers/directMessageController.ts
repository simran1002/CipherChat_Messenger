import type { Request, Response } from "express";
import mongoose from "mongoose";
import { DirectMessage } from "../models/DirectMessage.js";
import { User } from "../models/User.js";
import { HttpError } from "../errors/HttpError.js";
import { logger } from "../utils/logger.js";

// GET /dm — list all conversations for the logged-in user
export async function getConversations(req: Request, res: Response): Promise<void> {
  const userId = req.payload!.id;

  // Project only the last message — the old query loaded every message of
  // every conversation into memory just to read the final element.
  const conversations = await DirectMessage.find({ participants: userId })
    .populate("participants", "name email dp")
    .select({ participants: 1, lastMessageAt: 1, messages: { $slice: -1 } })
    .sort({ lastMessageAt: -1 })
    .lean();

  const result = conversations.map((conv) => {
    const participants = conv.participants as unknown as Array<{ _id: mongoose.Types.ObjectId }>;
    const other = participants.find((p) => p._id.toString() !== userId);
    const lastMsg = conv.messages[conv.messages.length - 1] ?? null;
    return {
      _id: conv._id,
      participant: other,
      lastMessage: lastMsg ? { message: lastMsg.message, createdAt: lastMsg.createdAt } : null,
      lastMessageAt: conv.lastMessageAt,
    };
  });

  res.json(result);
}

// GET /dm/:conversationId/messages — paginated messages
export async function getMessages(req: Request, res: Response): Promise<void> {
  const { conversationId } = req.params as { conversationId: string };
  const userId = req.payload!.id;
  const page = parseInt(String(req.query.page)) || 1;
  const limit = parseInt(String(req.query.limit)) || 50;

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    throw HttpError.badRequest("Invalid conversation ID.");

  const conv = await DirectMessage.findOne({
    _id: conversationId,
    participants: userId,
  }).populate("participants", "name email dp");

  if (!conv) throw HttpError.notFound("Conversation not found.");

  const total = conv.messages.length;
  const start = Math.max(0, total - page * limit);
  const end = total - (page - 1) * limit;
  const messages = conv.messages.slice(start, end);

  const participants = conv.participants as unknown as Array<{
    _id: mongoose.Types.ObjectId;
    name?: string;
    email?: string;
    dp?: string;
  }>;
  const userMap: Record<string, unknown> = {};
  participants.forEach((p) => {
    userMap[p._id.toString()] = p;
  });

  const other = participants.find((p) => p._id.toString() !== userId);

  res.json({
    messages: messages.map((m) => ({
      _id: m._id,
      message: m.message,
      edited: m.edited,
      userId: m.user.toString(),
      user: userMap[m.user.toString()] ?? null,
      createdAt: m.createdAt,
    })),
    participant: other,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

// POST /dm/start — get or create a conversation with another user
export async function startConversation(req: Request, res: Response): Promise<void> {
  const { targetUserId } = req.body as { targetUserId?: string };
  const userId = req.payload!.id;

  if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId))
    throw HttpError.badRequest("Invalid user ID.");
  if (targetUserId === userId) throw HttpError.badRequest("Cannot start a conversation with yourself.");

  const targetUser = await User.findById(targetUserId).select("name email dp");
  if (!targetUser) throw HttpError.notFound("User not found.");

  let conv = await DirectMessage.findOne({
    participants: { $all: [userId, targetUserId], $size: 2 },
  }).populate("participants", "name email dp");

  if (!conv) {
    conv = new DirectMessage({ participants: [userId, targetUserId], messages: [] });
    await conv.save();
    conv = await conv.populate("participants", "name email dp");
    logger.info("DM conversation started", { userId, targetUserId });
  }

  const participants = conv.participants as unknown as Array<{ _id: mongoose.Types.ObjectId }>;
  const other = participants.find((p) => p._id.toString() !== userId);
  res.json({ _id: conv._id, participant: other });
}

// GET /dm/users — list all users (for starting new DMs)
export async function getUsers(req: Request, res: Response): Promise<void> {
  const userId = req.payload!.id;
  const users = await User.find({ _id: { $ne: userId } }).select("name email dp").sort({ name: 1 });
  res.json(users);
}
