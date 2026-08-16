import type { Request, Response } from "express";
import mongoose from "mongoose";
import { DirectMessage } from "../models/DirectMessage.js";
import { DMMessage } from "../models/DMMessage.js";
import { User } from "../models/User.js";
import { HttpError } from "../errors/HttpError.js";
import { logger } from "../utils/logger.js";

/**
 * Sidebar previews are content-free by design: for E2EE messages the server
 * only knows "a message exists" — the client decrypts and caches its own
 * preview locally. Legacy plaintext rows still preview their body.
 */
function previewOf(row: { type: string; body?: string; createdAt?: Date } | null) {
  if (!row) return null;
  return {
    message: row.type === "e2ee/v1" ? "🔒 Encrypted message" : (row.body ?? ""),
    encrypted: row.type === "e2ee/v1",
    createdAt: row.createdAt,
  };
}

// GET /dm — list all conversations for the logged-in user
export async function getConversations(req: Request, res: Response): Promise<void> {
  const userId = req.payload!.id;

  const conversations = await DirectMessage.find({ participants: userId })
    .populate("participants", "name email dp")
    .select("participants lastMessageAt")
    .sort({ lastMessageAt: -1 })
    .lean();

  // Last message per conversation in ONE query (no N+1): group-by with $top
  const ids = conversations.map((c) => c._id);
  const lastRows = await DMMessage.aggregate<{
    _id: mongoose.Types.ObjectId;
    type: string;
    body?: string;
    createdAt: Date;
  }>([
    { $match: { conversationId: { $in: ids } } },
    { $sort: { conversationId: 1, createdAt: -1 } },
    {
      $group: {
        _id: "$conversationId",
        type: { $first: "$type" },
        body: { $first: "$body" },
        createdAt: { $first: "$createdAt" },
      },
    },
  ]);
  const lastByConv = new Map(lastRows.map((r) => [r._id.toString(), r]));

  const result = conversations.map((conv) => {
    const participants = conv.participants as unknown as Array<{ _id: mongoose.Types.ObjectId }>;
    const other = participants.find((p) => p._id.toString() !== userId);
    return {
      _id: conv._id,
      participant: other,
      lastMessage: previewOf(lastByConv.get(conv._id.toString()) ?? null),
      lastMessageAt: conv.lastMessageAt,
    };
  });

  res.json(result);
}

// GET /dm/:conversationId/messages — paginated messages (newest page = 1)
export async function getMessages(req: Request, res: Response): Promise<void> {
  const { conversationId } = req.params as { conversationId: string };
  const userId = req.payload!.id;
  const page = parseInt(String(req.query.page)) || 1;
  const limit = Math.min(parseInt(String(req.query.limit)) || 50, 100);

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    throw HttpError.badRequest("Invalid conversation ID.");

  const conv = await DirectMessage.findOne({
    _id: conversationId,
    participants: userId,
  })
    .select("participants")
    .populate("participants", "name email dp");

  if (!conv) throw HttpError.notFound("Conversation not found.");

  const total = await DMMessage.countDocuments({ conversationId });
  const rows = await DMMessage.find({ conversationId })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();
  rows.reverse(); // oldest-first within the page, like the old API

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
    messages: rows.map((m) => ({
      _id: m._id,
      type: m.type,
      message: m.type === "plaintext-legacy" ? m.body : undefined,
      envelope: m.type === "e2ee/v1" ? m.envelope : undefined,
      clientMessageId: m.clientMessageId,
      edited: m.edited,
      userId: m.senderId.toString(),
      user: userMap[m.senderId.toString()] ?? null,
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
