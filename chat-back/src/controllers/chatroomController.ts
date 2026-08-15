import type { Request, Response } from "express";
import mongoose from "mongoose";
import { Chatroom } from "../models/Chatroom.js";
import { Message } from "../models/Message.js";
import { User } from "../models/User.js";
import { HttpError } from "../errors/HttpError.js";
import { logger } from "../utils/logger.js";

const NAME_REGEX = /^[A-Za-z0-9\s\-_]+$/;

/** Escape user input before embedding it in a RegExp (ReDoS/injection guard). */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertObjectId(id: string, label: string): void {
  if (!mongoose.Types.ObjectId.isValid(id)) throw HttpError.badRequest(`Invalid ${label} ID.`);
}

export async function createChatroom(req: Request, res: Response): Promise<void> {
  const { name } = req.body as { name?: string };
  if (!name || !name.trim()) throw HttpError.badRequest("Chatroom name is required.");
  if (!NAME_REGEX.test(name))
    throw HttpError.badRequest(
      "Chatroom name can only contain letters, numbers, spaces, hyphens, and underscores."
    );
  if (name.trim().length > 50) throw HttpError.badRequest("Chatroom name cannot exceed 50 characters.");

  const chatroomExists = await Chatroom.findOne({
    name: { $regex: new RegExp(`^${escapeRegex(name.trim())}$`, "i") },
  });
  if (chatroomExists) throw HttpError.conflict("Chatroom with that name already exists!", "chatroom_exists");

  const chatroom = new Chatroom({ name: name.trim(), createdBy: req.payload!.id });
  await chatroom.save();
  res.json({ message: "Chatroom created!", chatroom });
}

export async function getAllChatrooms(_req: Request, res: Response): Promise<void> {
  const chatrooms = await Chatroom.find({}).populate("createdBy", "name").sort({ createdAt: -1 });
  res.json(chatrooms);
}

export async function getChatroomMessages(req: Request, res: Response): Promise<void> {
  const { chatroomId } = req.params as { chatroomId: string };
  const page = parseInt(String(req.query.page)) || 1;
  const limit = parseInt(String(req.query.limit)) || 50;
  const skip = (page - 1) * limit;

  assertObjectId(chatroomId, "chatroom");
  const chatroom = await Chatroom.findById(chatroomId);
  if (!chatroom) throw HttpError.notFound("Chatroom not found.");

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
}

export async function editMessage(req: Request, res: Response): Promise<void> {
  const { messageId } = req.params as { messageId: string };
  const { message } = req.body as { message?: string };
  if (!message || !message.trim()) throw HttpError.badRequest("Message content is required.");
  if (message.length > 2000) throw HttpError.badRequest("Message cannot exceed 2000 characters.");
  assertObjectId(messageId, "message");

  const msg = await Message.findById(messageId);
  if (!msg) throw HttpError.notFound("Message not found.");
  if (msg.user.toString() !== req.payload!.id)
    throw HttpError.forbidden("You can only edit your own messages.", "not_owner");

  msg.message = message.trim();
  msg.edited = true;
  await msg.save();
  logger.info("Message edited", { messageId, userId: req.payload!.id });
  res.json({ message: "Message updated.", updatedMessage: msg });
}

export async function deleteMessage(req: Request, res: Response): Promise<void> {
  const { messageId } = req.params as { messageId: string };
  assertObjectId(messageId, "message");

  const msg = await Message.findById(messageId);
  if (!msg) throw HttpError.notFound("Message not found.");
  if (msg.user.toString() !== req.payload!.id)
    throw HttpError.forbidden("You can only delete your own messages.", "not_owner");

  await msg.deleteOne();
  logger.info("Message deleted", { messageId, userId: req.payload!.id });
  res.json({ message: "Message deleted.", messageId });
}

export async function pinMessage(req: Request, res: Response): Promise<void> {
  const { messageId } = req.params as { messageId: string };
  assertObjectId(messageId, "message");
  const msg = await Message.findById(messageId);
  if (!msg) throw HttpError.notFound("Message not found.");
  msg.pinned = !msg.pinned;
  await msg.save();
  res.json({
    message: msg.pinned ? "Message pinned." : "Message unpinned.",
    pinned: msg.pinned,
    messageId,
  });
}

export async function getPinnedMessages(req: Request, res: Response): Promise<void> {
  const { chatroomId } = req.params as { chatroomId: string };
  assertObjectId(chatroomId, "chatroom");
  const messages = await Message.find({ chatroom: chatroomId, pinned: true })
    .populate("user", "name dp")
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
  res.json(messages);
}

export async function searchMessages(req: Request, res: Response): Promise<void> {
  const { chatroomId } = req.params as { chatroomId: string };
  const q = typeof req.query.q === "string" ? req.query.q : "";
  assertObjectId(chatroomId, "chatroom");
  if (!q.trim()) throw HttpError.badRequest("Search query is required.");

  const messages = await Message.find({
    chatroom: chatroomId,
    // Escaped — raw user input in $regex was a ReDoS vector
    message: { $regex: escapeRegex(q.trim()), $options: "i" },
  })
    .populate("user", "name dp")
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  res.json({ messages, query: q.trim() });
}

export async function toggleReaction(req: Request, res: Response): Promise<void> {
  const { messageId } = req.params as { messageId: string };
  const { emoji } = req.body as { emoji?: string };
  const userId = req.payload!.id;

  assertObjectId(messageId, "message");
  if (!emoji) throw HttpError.badRequest("Emoji is required.");

  const msg = await Message.findById(messageId);
  if (!msg) throw HttpError.notFound("Message not found.");

  const existing = msg.reactions.find((r) => r.emoji === emoji && r.user.toString() === userId);
  if (existing) {
    msg.reactions = msg.reactions.filter(
      (r) => !(r.emoji === emoji && r.user.toString() === userId)
    ) as typeof msg.reactions;
  } else {
    // The old code read req.payload.name, which was never in the token → always ""
    const reactor = await User.findById(userId).select("name").lean();
    msg.reactions.push({ emoji, user: userId, name: reactor?.name ?? "" } as never);
  }

  await msg.save();
  res.json({ reactions: msg.reactions, messageId });
}

// Mark all messages in a room as read by this user (up to and including the latest)
export async function markRead(req: Request, res: Response): Promise<void> {
  const { chatroomId } = req.params as { chatroomId: string };
  const userId = req.payload!.id;
  const { upToSequence } = req.body as { upToSequence?: number };

  assertObjectId(chatroomId, "chatroom");

  const filter: Record<string, unknown> = {
    chatroom: chatroomId,
    user: { $ne: userId }, // don't mark own messages as "read by me"
    "readBy.user": { $ne: userId },
  };
  if (upToSequence) filter.sequenceNumber = { $lte: upToSequence };

  const result = await Message.updateMany(filter, {
    $push: { readBy: { user: userId, readAt: new Date() } },
  });

  res.json({ marked: result.modifiedCount });
}

// Confirm a single message was delivered to this device
export async function markDelivered(req: Request, res: Response): Promise<void> {
  const { messageId } = req.params as { messageId: string };
  const userId = req.payload!.id;

  assertObjectId(messageId, "message");

  await Message.updateOne(
    { _id: messageId, deliveredTo: { $ne: userId } },
    { $push: { deliveredTo: userId } }
  );

  res.json({ ok: true });
}
