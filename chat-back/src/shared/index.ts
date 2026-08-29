/**
 * Composition root for the reliability layer.
 *
 * With REDIS_URL configured, coordination state (dedup, sequences, rate
 * limits, presence roster) lives in Redis and any number of replicas behave
 * as one logical server. Without it, in-memory implementations keep local
 * dev and unit tests dependency-free.
 *
 * Deliberately NOT in Redis:
 * - PresenceHeartbeat: miss-counting is socket-affine (sticky sessions);
 *   the Redis presence hash TTL is the cross-pod safety net.
 * - MetricsCollector: per-process by design; Prometheus aggregates across
 *   pods at scrape time (see metrics.ts).
 */
import { Message } from "../models/Message.js";
import { createRedisConnection, getRedis, redisEnabled } from "../config/redis.js";
import type {
  IDeduplicator,
  IPresenceRegistry,
  IRateLimiter,
  ISequenceCounter,
  ITypingStateManager,
} from "./interfaces.js";
import { MessageDeduplicator } from "./MessageDeduplicator.js";
import { MetricsCollector } from "./MetricsCollector.js";
import { PresenceHeartbeat } from "./PresenceHeartbeat.js";
import { PresenceRegistry } from "./PresenceRegistry.js";
import { RateLimiter } from "./RateLimiter.js";
import { SequenceCounter } from "./SequenceCounter.js";
import { TypingStateManager } from "./TypingStateManager.js";
import { RedisDeduplicator } from "./redis/RedisDeduplicator.js";
import { RedisPresenceRegistry } from "./redis/RedisPresenceRegistry.js";
import { RedisRateLimiter } from "./redis/RedisRateLimiter.js";
import { RedisSequenceCounter } from "./redis/RedisSequenceCounter.js";
import { RedisTypingStateManager } from "./redis/RedisTypingStateManager.js";

/** Seed source: highest sequence number already persisted for the room. */
async function maxPersistedSequence(chatroomId: string): Promise<number> {
  const latest = await Message.findOne({ chatroom: chatroomId })
    .sort({ sequenceNumber: -1 })
    .select("sequenceNumber")
    .lean();
  return latest?.sequenceNumber ?? 0;
}

export const dedup: IDeduplicator = redisEnabled
  ? new RedisDeduplicator(getRedis())
  : new MessageDeduplicator();

export const seqCounter: ISequenceCounter = redisEnabled
  ? new RedisSequenceCounter(getRedis(), maxPersistedSequence)
  : new SequenceCounter(maxPersistedSequence);

export const rateLimiter: IRateLimiter = redisEnabled
  ? new RedisRateLimiter(getRedis())
  : new RateLimiter();

export const presenceRegistry: IPresenceRegistry = redisEnabled
  ? new RedisPresenceRegistry(getRedis())
  : new PresenceRegistry();

// Typing: Redis TTL keys + keyspace notifications — if the pod owning the
// typist's socket dies, the key still expires and surviving pods clear the
// indicator (no ghost typers across a pod kill).
export const typingMgr: ITypingStateManager = redisEnabled
  ? new RedisTypingStateManager(getRedis(), () => createRedisConnection("typing-sub"))
  : new TypingStateManager();

export const heartbeat = new PresenceHeartbeat();
export const metrics = new MetricsCollector();

/** Graceful-shutdown hook: stops every timer the reliability layer owns. */
export function stopSharedModules(): void {
  if (dedup instanceof MessageDeduplicator) dedup.stop();
  metrics.stop();
  heartbeat.stopAll();
  void typingMgr.dispose();
}
