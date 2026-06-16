/**
 * Per-chatroom monotonic sequence counter.
 * Guarantees ordered delivery — server stamps each message with a sequence
 * number; clients buffer and re-order out-of-order arrivals.
 * Production: replace Map with Redis INCR {room}:seq
 */
class SequenceCounter {
  constructor() {
    this.counters = new Map(); // chatroomId → lastSeq
  }

  next(chatroomId) {
    const n = (this.counters.get(chatroomId) || 0) + 1;
    this.counters.set(chatroomId, n);
    return n;
  }

  current(chatroomId) {
    return this.counters.get(chatroomId) || 0;
  }
}

module.exports = new SequenceCounter();
