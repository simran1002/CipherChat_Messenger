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
  invalidateRoomCache(chatroomId);
}

// ── Hot-path room cache ───────────────────────────────────────────────────────
//
// The message send path used to fetch the full room document from Mongo for
// EVERY message — the single largest per-message cost under load (the hot-room
// k6 run measured ~700ms average server time, dominated by per-message DB
// round-trips). Sends only need a small, slowly-changing summary, so it is
// cached for a short TTL. Mutations on THIS process invalidate immediately;
// other replicas converge within the TTL — a bounded-staleness window that
// only delays membership revocation, never grants access a fresh read would
// deny for public rooms. Entry decisions (joinRoom, REST reads) still use the
// uncached path.

export interface RoomSummary {
  id: string;
  name: string;
  isPrivate: boolean;
  members: Array<{ user: string; role: RoomRole }>;
}

const ROOM_CACHE_TTL_MS = 15_000;
const ROOM_CACHE_MAX = 500;
const roomCache = new Map<string, { summary: RoomSummary | null; expiresAt: number }>();

export function invalidateRoomCache(chatroomId: string): void {
  roomCache.delete(chatroomId);
}

async function getRoomSummary(chatroomId: string): Promise<RoomSummary | null> {
  const hit = roomCache.get(chatroomId);
  if (hit && hit.expiresAt > Date.now()) return hit.summary;

  if (!mongoose.Types.ObjectId.isValid(chatroomId)) return null;
  const room = await Chatroom.findById(chatroomId).select("name isPrivate members").lean();
  const summary: RoomSummary | null = room
    ? {
        id: room._id.toString(),
        name: room.name,
        isPrivate: Boolean(room.isPrivate),
        members: (room.members ?? []).map((m) => ({
          user: m.user.toString(),
          role: (m.role ?? "member") as RoomRole,
        })),
      }
    : null;

  if (roomCache.size >= ROOM_CACHE_MAX) {
    // Simple bound: drop the oldest insertion (Map preserves insert order)
    const oldest = roomCache.keys().next().value;
    if (oldest !== undefined) roomCache.delete(oldest);
  }
  roomCache.set(chatroomId, { summary, expiresAt: Date.now() + ROOM_CACHE_TTL_MS });
  return summary;
}

/**
 * Send-path access check on the cached summary: null when the room doesn't
 * exist or a private room excludes the user. Same rules as assertRoomAccess.
 */
export async function getAccessibleRoomSummary(
  chatroomId: string,
  userId: string
): Promise<RoomSummary | null> {
  const summary = await getRoomSummary(chatroomId);
  if (!summary) return null;
  if (summary.isPrivate && !summary.members.some((m) => m.user === userId)) return null;
  return summary;
}

/** Assert the user holds one of the given roles in the room. */
export function assertRole(room: ChatroomDocument, userId: string, roles: RoomRole[]): RoomRole {
  const role = memberRole(room, userId);
  if (!role || !roles.includes(role)) {
    throw HttpError.forbidden("You do not have permission to do that in this room.", "insufficient_role");
  }
  return role;
}
