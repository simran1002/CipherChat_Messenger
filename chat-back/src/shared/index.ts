/**
 * Composition root for the reliability layer.
 *
 * Everything is exported as a singleton built from the in-memory
 * implementations; Phase 2 turns this into a factory that returns
 * Redis-backed implementations when REDIS_URL is configured.
 */
import { Message } from "../models/Message.js";
import { MessageDeduplicator } from "./MessageDeduplicator.js";
import { MetricsCollector } from "./MetricsCollector.js";
import { PresenceHeartbeat } from "./PresenceHeartbeat.js";
import { PresenceRegistry } from "./PresenceRegistry.js";
import { RateLimiter } from "./RateLimiter.js";
import { SequenceCounter } from "./SequenceCounter.js";
import { TypingStateManager } from "./TypingStateManager.js";

export const dedup = new MessageDeduplicator();

/** Seeded from Mongo so a restart never re-issues sequence numbers. */
export const seqCounter = new SequenceCounter(async (chatroomId) => {
  const latest = await Message.findOne({ chatroom: chatroomId })
    .sort({ sequenceNumber: -1 })
    .select("sequenceNumber")
    .lean();
  return latest?.sequenceNumber ?? 0;
});

export const typingMgr = new TypingStateManager();
export const heartbeat = new PresenceHeartbeat();
export const rateLimiter = new RateLimiter();
export const metrics = new MetricsCollector();
export const presenceRegistry = new PresenceRegistry();

/** Graceful-shutdown hook: stops every timer the reliability layer owns. */
export function stopSharedModules(): void {
  dedup.stop();
  metrics.stop();
  heartbeat.stopAll();
}
