import { User } from "../models/User.js";
import { presenceRegistry } from "../shared/index.js";

export interface SenderInfo {
  name: string;
  dp: string;
}

/**
 * Display info for a message sender. A sender is (almost) always a connected
 * user, so the presence registry — an in-memory map, or one Redis GET in
 * multi-replica mode — answers without touching MongoDB. The DB fallback
 * covers the narrow window where presence timed out but the socket is still
 * up. The message hot path used to run a Mongo findById for EVERY message.
 */
export async function senderInfo(userId: string): Promise<SenderInfo | null> {
  const online = await presenceRegistry.get(userId);
  if (online) return { name: online.name, dp: online.dp || "" };
  const user = await User.findById(userId).select("name dp").lean();
  return user ? { name: user.name, dp: user.dp || "" } : null;
}
