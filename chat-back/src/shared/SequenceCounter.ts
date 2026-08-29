import type { ISequenceCounter } from "./interfaces.js";

/**
 * Per-chatroom monotonic sequence counter.
 * Server stamps each message; clients buffer and re-order out-of-order arrivals.
 * Redis swap (Phase 2): INCR seq:{room}, seeded from Mongo max(sequenceNumber)
 * so a process restart never re-issues numbers.
 *
 * Concurrency note: JS is single-threaded, but `await` points are yield
 * points — an earlier version read the counter, awaited the seed, then wrote
 * it back, so N concurrent sends on a cold room could all seed and hand out
 * duplicate numbers (caught by the DB's unique {chatroom, sequenceNumber}
 * backstop once the send path got fast enough to actually race). The seed is
 * now single-flight per room and the increment is a synchronous
 * read-modify-write with no await in between.
 */
export class SequenceCounter implements ISequenceCounter {
  private readonly counters = new Map<string, number>();
  private readonly seeding = new Map<string, Promise<number>>();

  /**
   * Optional seed source: called once per unseen room to initialize the
   * counter (e.g. max(sequenceNumber) from the database). Fixes the
   * restart-resets-to-zero bug even in the in-memory implementation.
   */
  constructor(private readonly seed?: (chatroomId: string) => Promise<number>) {}

  async next(chatroomId: string): Promise<number> {
    await this.ensureSeeded(chatroomId);
    // Synchronous read-modify-write — atomic on the event loop
    const n = (this.counters.get(chatroomId) ?? 0) + 1;
    this.counters.set(chatroomId, n);
    return n;
  }

  async current(chatroomId: string): Promise<number> {
    await this.ensureSeeded(chatroomId);
    return this.counters.get(chatroomId) ?? 0;
  }

  private async ensureSeeded(chatroomId: string): Promise<void> {
    if (this.counters.has(chatroomId)) return;

    // Single-flight: concurrent callers on a cold room share one seed lookup
    let inflight = this.seeding.get(chatroomId);
    if (!inflight) {
      inflight = this.seed ? this.seed(chatroomId) : Promise.resolve(0);
      this.seeding.set(chatroomId, inflight);
    }
    try {
      const seeded = await inflight;
      if (!this.counters.has(chatroomId)) this.counters.set(chatroomId, seeded);
    } finally {
      this.seeding.delete(chatroomId);
    }
  }
}
