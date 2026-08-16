/**
 * One-time migration: copy embedded DirectMessage.messages[] rows into the
 * DMMessage collection as type "plaintext-legacy".
 *
 * Idempotent: re-running skips conversations whose messages already exist
 * (matched by legacy _id stamped into clientMessageId as "legacy:<id>").
 * The embedded array is left in place as a backup; drop it manually once
 * satisfied:  db.directmessages.updateMany({}, { $unset: { messages: 1 } })
 *
 * Run:  npx tsx src/scripts/migrateDmMessages.ts
 */
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { DirectMessage } from "../models/DirectMessage.js";
import { DMMessage } from "../models/DMMessage.js";

async function main(): Promise<void> {
  await mongoose.connect(env.DATABASE);
  logger.info("Migration connected", { db: mongoose.connection.name });

  const conversations = await DirectMessage.find({ "messages.0": { $exists: true } });
  let migrated = 0;
  let skipped = 0;

  for (const conv of conversations) {
    for (const legacy of conv.messages) {
      const legacyKey = `legacy:${legacy._id}`;
      const exists = await DMMessage.exists({
        conversationId: conv._id,
        clientMessageId: legacyKey,
      });
      if (exists) {
        skipped++;
        continue;
      }
      await DMMessage.create({
        conversationId: conv._id,
        senderId: legacy.user,
        clientMessageId: legacyKey,
        type: "plaintext-legacy",
        body: legacy.message,
        edited: legacy.edited ?? false,
        // preserve original timestamps
        createdAt: legacy.createdAt,
        updatedAt: legacy.createdAt,
      });
      migrated++;
    }
  }

  logger.info("Migration complete", { conversations: conversations.length, migrated, skipped });
  await mongoose.disconnect();
}

main().catch((err) => {
  logger.error("Migration failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
