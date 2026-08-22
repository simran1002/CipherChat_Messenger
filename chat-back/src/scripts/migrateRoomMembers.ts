/**
 * One-time backfill for the membership model: every room that predates
 * members[] gets its creator as owner. Rooms with no createdBy (very old
 * rows) stay public with an empty roster — the first joiner becomes a member.
 *
 * Idempotent — reruns only touch rooms whose members[] is still empty.
 *
 *   npx tsx src/scripts/migrateRoomMembers.ts
 */
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Chatroom } from "../models/Chatroom.js";
import { logger } from "../utils/logger.js";

async function main(): Promise<void> {
  await mongoose.connect(env.DATABASE);

  const rooms = await Chatroom.find({
    $or: [{ members: { $size: 0 } }, { members: { $exists: false } }],
  });

  let migrated = 0;
  for (const room of rooms) {
    if (!room.createdBy) continue;
    room.members.push({ user: room.createdBy, role: "owner", joinedAt: room.createdAt } as never);
    await room.save();
    migrated++;
  }

  logger.info("Room membership backfill complete", {
    scanned: rooms.length,
    migrated,
    skippedNoCreator: rooms.length - migrated,
  });
  await mongoose.disconnect();
}

main().catch((err) => {
  logger.error("Migration failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
