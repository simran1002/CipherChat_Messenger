import type { IDeduplicator } from "./interfaces.js";

/**
 * In-memory deduplicator for idempotent message processing.
 * Stores clientMessageId → serverId for a rolling window (default 10 min).
 * Redis swap (Phase 2): SET dedup:{clientId} {serverId} NX EX 600.
 */
export class MessageDeduplicator implements IDeduplicator {
  private readonly seen = new Map<string, { serverId: string; ts: number }>();
  private readonly ttlMs: number;
  private readonly evictTimer: NodeJS.Timeout;

  constructor(ttlMs = 10 * 60 * 1000, evictIntervalMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
    // unref() so a forgotten instance never keeps the process alive
    this.evictTimer = setInterval(() => this.evict(), evictIntervalMs);
    this.evictTimer.unref();
  }

  async check(clientMessageId: string): Promise<string | null> {
    return this.seen.get(clientMessageId)?.serverId ?? null;
  }

  async mark(clientMessageId: string, serverId: string): Promise<void> {
    this.seen.set(clientMessageId, { serverId, ts: Date.now() });
  }

  stop(): void {
    clearInterval(this.evictTimer);
    this.seen.clear();
  }

  /** Exposed for tests. */
  evict(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, v] of this.seen) {
      if (v.ts < cutoff) this.seen.delete(k);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}
