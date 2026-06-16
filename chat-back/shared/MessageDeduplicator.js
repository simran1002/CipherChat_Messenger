/**
 * In-memory deduplicator for at-most-once message processing.
 * Stores clientMessageId → serverId for a rolling 10-minute window.
 * In production this would be a Redis SET with TTL.
 */
class MessageDeduplicator {
  constructor(ttlMs = 10 * 60 * 1000) {
    this.seen = new Map(); // clientId → { serverId, ts }
    this.ttlMs = ttlMs;

    // Evict old entries every 5 min
    setInterval(() => this._evict(), 5 * 60 * 1000);
  }

  // Returns existing serverId if duplicate, null if new
  check(clientMessageId) {
    const entry = this.seen.get(clientMessageId);
    if (entry) return entry.serverId;
    return null;
  }

  mark(clientMessageId, serverId) {
    this.seen.set(clientMessageId, { serverId, ts: Date.now() });
  }

  _evict() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, v] of this.seen) {
      if (v.ts < cutoff) this.seen.delete(k);
    }
  }
}

module.exports = new MessageDeduplicator();
