import type { Request, Response } from "express";
import mongoose from "mongoose";
import { Chatroom } from "../models/Chatroom.js";
import { Message } from "../models/Message.js";
import { RoomReadState } from "../models/RoomReadState.js";
import { User } from "../models/User.js";
import { HttpError } from "../errors/HttpError.js";
import {
  assertRoomAccess,
  assertRole,
  ensureMembership,
  invalidateRoomCache,
  memberRole,
} from "../services/roomAccess.js";
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
  const { name, isPrivate } = req.body as { name?: string; isPrivate?: boolean };
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

  const chatroom = new Chatroom({
    name: name.trim(),
    createdBy: req.payload!.id,
    isPrivate: Boolean(isPrivate),
    members: [{ user: req.payload!.id, role: "owner", joinedAt: new Date() }],
  });
  await chatroom.save();
  res.json({ message: "Chatroom created!", chatroom });
}

/**
 * Room list for the dashboard: public rooms + private rooms the user belongs
 * to, each with membership info and the user's unread count (messages above
 * their read watermark, not sent by them).
 */
export async function getAllChatrooms(req: Request, res: Response): Promise<void> {
  const userId = req.payload!.id;

  const chatrooms = await Chatroom.find({
    $or: [{ isPrivate: { $ne: true } }, { "members.user": userId }],
  })
    .populate("createdBy", "name")
    .sort({ createdAt: -1 })
    .lean();

  const readStates = await RoomReadState.find({ user: userId }).lean();
  const watermarks = new Map(readStates.map((r) => [r.chatroom.toString(), r.lastReadSequence]));

  // One indexed range-count per room ({chatroom, sequenceNumber} index).
  // Room count per org is small (tens); revisit with an aggregation if that
  // assumption breaks.
  const unreadCounts = await Promise.all(
    chatrooms.map((room) =>
      Message.countDocuments({
        chatroom: room._id,
        sequenceNumber: { $gt: watermarks.get(room._id.toString()) ?? 0 },
        user: { $ne: userId },
      })
    )
  );

  res.json(
    chatrooms.map((room, i) => {
      const my = room.members?.find((m) => m.user.toString() === userId);
      return {
        ...room,
        members: undefined, // full list via GET /:id/members — keep the payload lean
        memberCount: room.members?.length ?? 0,
        myRole: my?.role ?? null,
        unreadCount: unreadCounts[i],
      };
    })
  );
}

/**
 * Message history — cursor pagination only.
 * ?before=<messageId>&limit=50 returns the `limit` messages older than the
 * cursor, ascending, plus nextCursor/hasMore. No cursor = newest page.
 * ObjectIds are time-ordered, so `_id` works for rows that predate sequence
 * numbers, and an indexed `$lt` seek is O(log n) regardless of history depth
 * (the former offset/skip mode degraded linearly and was removed once all
 * clients moved to cursors).
 */
export async function getChatroomMessages(req: Request, res: Response): Promise<void> {
  const { chatroomId } = req.params as { chatroomId: string };
  const limit = Math.min(parseInt(String(req.query.limit)) || 50, 100);
  const before = typeof req.query.before === "string" ? req.query.before : undefined;

  const chatroom = await assertRoomAccess(chatroomId, req.payload!.id);

  const filter: Record<string, unknown> = { chatroom: chatroomId };
  if (before) {
    assertObjectId(before, "cursor");
    filter._id = { $lt: new mongoose.Types.ObjectId(before) };
  }

  const rows = await Message.find(filter)
    .populate("user", "name email dp")
    .sort({ _id: -1 })
    .limit(limit + 1) // one extra row = "is there more?"
    .lean();

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit).reverse(); // ascending for rendering

  res.json({
    messages: pageRows,
    chatroom: { name: chatroom.name, id: chatroom._id, isPrivate: chatroom.isPrivate },
    cursor: {
      nextCursor: hasMore && pageRows.length ? String(pageRows[0]!._id) : null,
      hasMore,
      limit,
    },
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

  // Pinning requires access to the room the message lives in (previously any
  // authenticated user could pin anything, anywhere)
  await assertRoomAccess(msg.chatroom.toString(), req.payload!.id);

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
  await assertRoomAccess(chatroomId, req.payload!.id);
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
  await assertRoomAccess(chatroomId, req.payload!.id);
  if (!q.trim()) throw HttpError.badRequest("Search query is required.");

  const term = q.trim();

  // Primary: the compound text index {chatroom, message:"text"} — stemmed,
  // whole-word, O(index) rather than an O(room) regex scan. Ranked by score.
  let messages = await Message.find(
    { chatroom: chatroomId, $text: { $search: term } },
    { score: { $meta: "textScore" } }
  )
    .populate("user", "name dp")
    .sort({ score: { $meta: "textScore" }, createdAt: -1 })
    .limit(50)
    .lean();

  // Fallback: partial words / stop-words / symbols that text search can't
  // match. Escaped — raw user input in $regex was a ReDoS vector.
  if (messages.length === 0) {
    messages = await Message.find({
      chatroom: chatroomId,
      message: { $regex: escapeRegex(term), $options: "i" },
    })
      .populate("user", "name dp")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
  }

  res.json({ messages, query: term });
}

export async function toggleReaction(req: Request, res: Response): Promise<void> {
  const { messageId } = req.params as { messageId: string };
  const { emoji } = req.body as { emoji?: string };
  const userId = req.payload!.id;

  assertObjectId(messageId, "message");
  if (!emoji) throw HttpError.badRequest("Emoji is required.");

  const msg = await Message.findById(messageId);
  if (!msg) throw HttpError.notFound("Message not found.");
  await assertRoomAccess(msg.chatroom.toString(), userId);

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

  await assertRoomAccess(chatroomId, userId);

  const filter: Record<string, unknown> = {
    chatroom: chatroomId,
    user: { $ne: userId }, // don't mark own messages as "read by me"
    "readBy.user": { $ne: userId },
  };
  if (upToSequence) filter.sequenceNumber = { $lte: upToSequence };

  const result = await Message.updateMany(filter, {
    $push: { readBy: { user: userId, readAt: new Date() } },
  });

  // Advance the unread-badge watermark (never backwards)
  const watermark =
    upToSequence ??
    (await Message.findOne({ chatroom: chatroomId })
      .sort({ sequenceNumber: -1 })
      .select("sequenceNumber")
      .lean())?.sequenceNumber ??
    0;
  await RoomReadState.updateOne(
    { user: userId, chatroom: chatroomId, lastReadSequence: { $lt: watermark } },
    { $set: { lastReadSequence: watermark } },
    { upsert: true }
  ).catch(async (err: unknown) => {
    // upsert + $lt filter races the unique index when the row doesn't exist
    // yet and two requests arrive together — the loser retries as plain $max
    if ((err as { code?: number }).code === 11000) {
      await RoomReadState.updateOne(
        { user: userId, chatroom: chatroomId },
        { $max: { lastReadSequence: watermark } }
      );
    } else {
      throw err;
    }
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

// ── Membership management ─────────────────────────────────────────────────────

export async function getMembers(req: Request, res: Response): Promise<void> {
  const { chatroomId } = req.params as { chatroomId: string };
  const room = await assertRoomAccess(chatroomId, req.payload!.id);
  // Compute the caller's role BEFORE populate() — populate mutates the doc in
  // place, turning members.user into User documents whose toString() is no
  // longer the id (memberRole would then return null for everyone).
  const myRole = memberRole(room, req.payload!.id);
  const populated = await room.populate("members.user", "name email dp isOnline");
  res.json({
    members: populated.members.map((m) => ({
      user: m.user,
      role: m.role,
      joinedAt: m.joinedAt,
    })),
    isPrivate: room.isPrivate,
    myRole,
  });
}

/** POST /chatroom/:chatroomId/join — self-service join for PUBLIC rooms. */
export async function joinRoom(req: Request, res: Response): Promise<void> {
  const { chatroomId } = req.params as { chatroomId: string };
  const room = await assertRoomAccess(chatroomId, req.payload!.id); // 403s on private non-member
  await ensureMembership(chatroomId, req.payload!.id);
  res.json({ message: `Joined ${room.name}.`, chatroomId });
}

/** POST /chatroom/:chatroomId/invite {userId} — owner/admin only. */
export async function inviteMember(req: Request, res: Response): Promise<void> {
  const { chatroomId } = req.params as { chatroomId: string };
  const { userId: inviteeId } = req.body as { userId?: string };
  if (!inviteeId) throw HttpError.badRequest("userId is required.");
  assertObjectId(inviteeId, "user");

  const room = await assertRoomAccess(chatroomId, req.payload!.id);
  assertRole(room, req.payload!.id, ["owner", "admin"]);

  const invitee = await User.findById(inviteeId).select("name");
  if (!invitee) throw HttpError.notFound("User not found.");
  if (memberRole(room, inviteeId)) throw HttpError.conflict("User is already a member.", "already_member");

  await ensureMembership(chatroomId, inviteeId);
  logger.info("Room invite", { chatroomId, inviteeId, by: req.payload!.id });
  res.json({ message: `${invitee.name} added to the room.`, userId: inviteeId });
}

/** POST /chatroom/:chatroomId/leave — owners must transfer ownership first. */
export async function leaveRoom(req: Request, res: Response): Promise<void> {
  const { chatroomId } = req.params as { chatroomId: string };
  const userId = req.payload!.id;
  const room = await assertRoomAccess(chatroomId, userId);

  const role = memberRole(room, userId);
  if (!role) throw HttpError.badRequest("You are not a member of this room.", "not_member");
  if (role === "owner")
    throw HttpError.badRequest(
      "Owners must transfer ownership before leaving.",
      "owner_cannot_leave"
    );

  await Chatroom.updateOne({ _id: chatroomId }, { $pull: { members: { user: userId } } });
  invalidateRoomCache(chatroomId);
  res.json({ message: "Left the room.", chatroomId });
}

/**
 * PATCH /chatroom/:chatroomId/members/:userId {role} — owner only.
 * Promoting someone to owner transfers ownership (previous owner → admin).
 */
export async function updateMemberRole(req: Request, res: Response): Promise<void> {
  const { chatroomId, userId: targetId } = req.params as { chatroomId: string; userId: string };
  const { role } = req.body as { role?: string };
  assertObjectId(targetId, "user");
  if (role !== "admin" && role !== "member" && role !== "owner")
    throw HttpError.badRequest("Role must be owner, admin, or member.");

  const room = await assertRoomAccess(chatroomId, req.payload!.id);
  assertRole(room, req.payload!.id, ["owner"]);
  if (targetId === req.payload!.id) throw HttpError.badRequest("You cannot change your own role.");
  if (!memberRole(room, targetId)) throw HttpError.notFound("That user is not a member.", "not_member");

  if (role === "owner") {
    // Ownership transfer: exactly one owner at a time
    await Chatroom.updateOne(
      { _id: chatroomId, "members.user": req.payload!.id },
      { $set: { "members.$.role": "admin" } }
    );
  }
  await Chatroom.updateOne(
    { _id: chatroomId, "members.user": targetId },
    { $set: { "members.$.role": role } }
  );
  invalidateRoomCache(chatroomId);
  logger.info("Room role updated", { chatroomId, targetId, role, by: req.payload!.id });
  res.json({ message: "Role updated.", userId: targetId, role });
}
