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

export interface ITypingStateManager {
  start(chatroomId: string, userId: string, name: string, onExpire: (userId: string) => void): void;
  stop(chatroomId: string, userId: string): void;
  clearUser(userId: string): void;
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
  /** Serializable roster for the `onlineUsers` broadcast. */
  list(): Promise<OnlineUserPublic[]>;
}
