/**
 * TTL-based heartbeat presence tracker.
 * Clients send a `heartbeat` ping every INTERVAL_MS.
 * If a user misses MISS_THRESHOLD pings, they are marked offline.
 * This prevents "ghost online" users when a tab crashes without disconnect.
 */
const INTERVAL_MS = 30_000; // client pings every 30s
const MISS_THRESHOLD = 2;   // offline after 2 missed pings = 60s

class PresenceHeartbeat {
  constructor() {
    this.timers = new Map(); // userId → { timer, missCount }
  }

  beat(userId, onOffline) {
    this._clear(userId);
    const timer = setInterval(() => {
      const entry = this.timers.get(userId);
      if (!entry) return;
      entry.missCount = (entry.missCount || 0) + 1;
      if (entry.missCount >= MISS_THRESHOLD) {
        this._clear(userId);
        onOffline(userId);
      }
    }, INTERVAL_MS);
    this.timers.set(userId, { timer, missCount: 0 });
  }

  refresh(userId) {
    const entry = this.timers.get(userId);
    if (entry) entry.missCount = 0;
  }

  clear(userId) {
    this._clear(userId);
  }

  _clear(userId) {
    const entry = this.timers.get(userId);
    if (entry?.timer) clearInterval(entry.timer);
    this.timers.delete(userId);
  }
}

module.exports = new PresenceHeartbeat();
