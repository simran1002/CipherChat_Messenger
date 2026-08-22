import mongoose from "mongoose";
import { Chatroom, type ChatroomDocument, type RoomRole } from "../models/Chatroom.js";
import { HttpError } from "../errors/HttpError.js";

/**
 * Single authority for room permissions. Every REST controller and socket
 * handler that touches a room goes through here — before this existed, any
 * authenticated user could read, search, and pin in any room.
 *
 * Rules:
 * - Public room: any authenticated user may read and send; sending/joining
 *   records them as a member (participation list).
 * - Private room: members only, for everything.
 * - Invites / role changes: owner or admin. Role changes: owner only.
 */

export function memberRole(room: ChatroomDocument, userId: string): RoomRole | null {
  const entry = room.members.find((m) => m.user.toString() === userId);
  return (entry?.role as RoomRole | undefined) ?? null;
}

/**
 * Load the room and assert the user may access it (read or send).
 * Throws 404 for bad ids / missing rooms, 403 for private rooms the user
 * is not in.
 */
export async function assertRoomAccess(chatroomId: string, userId: string): Promise<ChatroomDocument> {
  if (!mongoose.Types.ObjectId.isValid(chatroomId)) throw HttpError.badRequest("Invalid chatroom ID.");
  const room = await Chatroom.findById(chatroomId);
  if (!room) throw HttpError.notFound("Chatroom not found.");
  if (room.isPrivate && !memberRole(room, userId)) {
    throw HttpError.forbidden("You are not a member of this room.", "not_member");
  }
  return room;
}

/** Same check, but boolean — for socket handlers that fail silently. */
export async function canAccessRoom(chatroomId: string, userId: string): Promise<boolean> {
  return (await getAccessibleRoom(chatroomId, userId)) !== null;
}

/** Room document if the user may access it, else null (socket-handler form). */
export async function getAccessibleRoom(
  chatroomId: string,
  userId: string
): Promise<ChatroomDocument | null> {
  try {
    return await assertRoomAccess(chatroomId, userId);
  } catch {
    return null;
  }
}

/** Record participation (idempotent). No-op if already a member. */
export async function ensureMembership(chatroomId: string, userId: string): Promise<void> {
  await Chatroom.updateOne(
    { _id: chatroomId, "members.user": { $ne: userId } },
    { $push: { members: { user: userId, role: "member", joinedAt: new Date() } } }
  );
}

/** Assert the user holds one of the given roles in the room. */
export function assertRole(room: ChatroomDocument, userId: string, roles: RoomRole[]): RoomRole {
  const role = memberRole(room, userId);
  if (!role || !roles.includes(role)) {
    throw HttpError.forbidden("You do not have permission to do that in this room.", "insufficient_role");
  }
  return role;
}
