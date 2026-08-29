/**
 * Contracts for the reliability-layer modules.
 *
 * Phase 0 ships in-memory implementations (single node). Phase 2 adds
 * Redis-backed implementations behind these same interfaces, selected by
 * config — callers never know which one they got.
 *
 * All methods are async-capable (Promise-returning) even where the in-memory
 * implementation is synchronous, so the Redis swap is signature-compatible.
 */

export interface IDeduplicator {
  /** Returns existing serverId if duplicate, null if new. */
  check(clientMessageId: string): Promise<string | null>;
  mark(clientMessageId: string, serverId: string): Promise<void>;
  stop(): void;
}

export interface ISequenceCounter {
  /** Next monotonic per-room sequence number. */
  next(chatroomId: string): Promise<number>;
  current(chatroomId: string): Promise<number>;
}

/**
 * How far the caller's expiry broadcast must travel:
 * - "cluster": only this manager instance saw the expiry (in-memory timers,
 *   or the Redis fallback mode) — broadcast through the adapter so every
 *   pod's sockets hear it.
 * - "pod-local": every pod's manager fires the same expiry (Redis keyspace
 *   notifications reach all subscribers) — broadcast to local sockets only,
 *   or the room hears it once per pod.
 */
export type TypingExpiryScope = "cluster" | "pod-local";

export interface ITypingStateManager {
  /** Single expiry handler, wired once at socket-server setup. */
  onExpire(handler: (chatroomId: string, userId: string, scope: TypingExpiryScope) => void): void;
  start(chatroomId: string, userId: string, name: string): void | Promise<void>;
  stop(chatroomId: string, userId: string): void | Promise<void>;
  clearUser(userId: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface IPresenceHeartbeat {
  beat(userId: string, onOffline: (userId: string) => void): void;
  refresh(userId: string): void;
  clear(userId: string): void;
  stopAll(): void;
}

export interface IRateLimiter {
  allow(userId: string): Promise<boolean>;
  clear(userId: string): Promise<void>;
}

export interface OnlineUserInfo {
  socketId: string;
  name: string;
  email: string;
  dp: string;
  presenceStatus: string;
  presenceNote: string;
}

export interface OnlineUserPublic {
  userId: string;
  name: string;
  dp: string;
  presenceStatus: string;
  presenceNote: string;
}

export interface IPresenceRegistry {
  set(userId: string, info: OnlineUserInfo): Promise<void>;
  get(userId: string): Promise<OnlineUserInfo | undefined>;
  update(userId: string, patch: Partial<OnlineUserInfo>): Promise<boolean>;
  delete(userId: string): Promise<void>;
  /** Heartbeat hook — refreshes any TTL-based liveness the backend keeps. */
  touch(userId: string): Promise<void>;
  /** Serializable roster for the `onlineUsers` broadcast. */
  list(): Promise<OnlineUserPublic[]>;
}
