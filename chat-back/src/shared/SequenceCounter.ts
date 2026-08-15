import type { ISequenceCounter } from "./interfaces.js";

/**
 * Per-chatroom monotonic sequence counter.
 * Server stamps each message; clients buffer and re-order out-of-order arrivals.
 * Redis swap (Phase 2): INCR seq:{room}, seeded from Mongo max(sequenceNumber)
 * so a process restart never re-issues numbers.
 */
export class SequenceCounter implements ISequenceCounter {
  private readonly counters = new Map<string, number>();

  /**
   * Optional seed source: called once per unseen room to initialize the
   * counter (e.g. max(sequenceNumber) from the database). Fixes the
   * restart-resets-to-zero bug even in the in-memory implementation.
   */
  constructor(private readonly seed?: (chatroomId: string) => Promise<number>) {}

  async next(chatroomId: string): Promise<number> {
    const n = (await this.ensure(chatroomId)) + 1;
    this.counters.set(chatroomId, n);
    return n;
  }

  async current(chatroomId: string): Promise<number> {
    return this.ensure(chatroomId);
  }

  private async ensure(chatroomId: string): Promise<number> {
    const existing = this.counters.get(chatroomId);
    if (existing !== undefined) return existing;
    const seeded = this.seed ? await this.seed(chatroomId) : 0;
    this.counters.set(chatroomId, seeded);
    return seeded;
  }
}
