/**
 * TTL-based typing state per room.
 * Solves the "ghost typing" problem — if a client disconnects mid-type
 * without emitting stopTyping, the state auto-expires after TTL_MS.
 */
const TTL_MS = 4000;

class TypingStateManager {
  constructor() {
    this.rooms = new Map(); // chatroomId → Map<userId, { name, timer }>
  }

  start(chatroomId, userId, name, onExpire) {
    if (!this.rooms.has(chatroomId)) this.rooms.set(chatroomId, new Map());
    const room = this.rooms.get(chatroomId);

    // Clear existing timer
    const existing = room.get(userId);
    if (existing?.timer) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      room.delete(userId);
      onExpire(userId);
    }, TTL_MS);

    room.set(userId, { name, timer });
  }

  stop(chatroomId, userId) {
    const room = this.rooms.get(chatroomId);
    if (!room) return;
    const entry = room.get(userId);
    if (entry?.timer) clearTimeout(entry.timer);
    room.delete(userId);
  }

  getTyping(chatroomId) {
    const room = this.rooms.get(chatroomId);
    if (!room) return [];
    return Array.from(room.entries()).map(([id, v]) => ({ userId: id, name: v.name }));
  }

  clearUser(userId) {
    for (const room of this.rooms.values()) {
      const entry = room.get(userId);
      if (entry?.timer) clearTimeout(entry.timer);
      room.delete(userId);
    }
  }
}

module.exports = new TypingStateManager();
