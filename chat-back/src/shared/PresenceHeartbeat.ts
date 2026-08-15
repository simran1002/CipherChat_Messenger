import type { IPresenceHeartbeat } from "./interfaces.js";

/**
 * TTL-based heartbeat presence tracker.
 * Clients ping every ~25s; missing `missThreshold` checks (default 2 × 30s)
 * marks the user offline. Prevents "ghost online" users when a tab crashes
 * without a socket disconnect.
 * Redis swap (Phase 2): key with EXPIRE refreshed on heartbeat.
 */
export class PresenceHeartbeat implements IPresenceHeartbeat {
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; missCount: number }>();

  constructor(
    private readonly intervalMs = 30_000,
    private readonly missThreshold = 2
  ) {}

  beat(userId: string, onOffline: (userId: string) => void): void {
    this.clear(userId);
    const timer = setInterval(() => {
      const entry = this.timers.get(userId);
      if (!entry) return;
      entry.missCount += 1;
      if (entry.missCount >= this.missThreshold) {
        this.clear(userId);
        onOffline(userId);
      }
    }, this.intervalMs);
    timer.unref();
    this.timers.set(userId, { timer, missCount: 0 });
  }

  refresh(userId: string): void {
    const entry = this.timers.get(userId);
    if (entry) entry.missCount = 0;
  }

  clear(userId: string): void {
    const entry = this.timers.get(userId);
    if (entry) clearInterval(entry.timer);
    this.timers.delete(userId);
  }

  stopAll(): void {
    for (const { timer } of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}
