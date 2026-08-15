import type { ITypingStateManager } from "./interfaces.js";

/**
 * TTL-based typing state per room.
 * Solves the "ghost typing" problem — if a client disconnects mid-type
 * without emitting stopTyping, the state auto-expires after ttlMs.
 */
export class TypingStateManager implements ITypingStateManager {
  private readonly rooms = new Map<string, Map<string, { name: string; timer: NodeJS.Timeout }>>();

  constructor(private readonly ttlMs = 4000) {}

  start(chatroomId: string, userId: string, name: string, onExpire: (userId: string) => void): void {
    let room = this.rooms.get(chatroomId);
    if (!room) {
      room = new Map();
      this.rooms.set(chatroomId, room);
    }

    const existing = room.get(userId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.deleteEntry(chatroomId, userId);
      onExpire(userId);
    }, this.ttlMs);
    timer.unref();

    room.set(userId, { name, timer });
  }

  stop(chatroomId: string, userId: string): void {
    const entry = this.rooms.get(chatroomId)?.get(userId);
    if (entry) clearTimeout(entry.timer);
    this.deleteEntry(chatroomId, userId);
  }

  clearUser(userId: string): void {
    for (const [chatroomId, room] of this.rooms) {
      const entry = room.get(userId);
      if (entry) clearTimeout(entry.timer);
      this.deleteEntry(chatroomId, userId, room);
    }
  }

  /** Delete the user's entry and GC the room map when it empties (old impl leaked these). */
  private deleteEntry(chatroomId: string, userId: string, room = this.rooms.get(chatroomId)): void {
    if (!room) return;
    room.delete(userId);
    if (room.size === 0) this.rooms.delete(chatroomId);
  }
}
