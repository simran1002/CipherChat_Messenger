import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageDeduplicator } from "../../src/shared/MessageDeduplicator.js";

describe("MessageDeduplicator (idempotency window)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for an unseen clientMessageId", async () => {
    const dedup = new MessageDeduplicator(1000, 500);
    expect(await dedup.check("never-seen")).toBeNull();
    dedup.stop();
  });

  it("returns the stored serverId after mark()", async () => {
    const dedup = new MessageDeduplicator(1000, 500);
    await dedup.mark("client-1", "server-1");
    expect(await dedup.check("client-1")).toBe("server-1");
    dedup.stop();
  });

  it("evict() removes only entries older than the TTL", async () => {
    const dedup = new MessageDeduplicator(1000, 60_000);
    await dedup.mark("old", "server-old");

    vi.advanceTimersByTime(1500); // "old" is now past the 1000ms TTL
    await dedup.mark("fresh", "server-fresh");

    dedup.evict();
    expect(await dedup.check("old")).toBeNull();
    expect(await dedup.check("fresh")).toBe("server-fresh");
    expect(dedup.size).toBe(1);
    dedup.stop();
  });

  it("evicts automatically on the configured interval", async () => {
    const dedup = new MessageDeduplicator(1000, 2000);
    await dedup.mark("a", "server-a");

    vi.advanceTimersByTime(2000); // interval fires; entry is 2000ms old > 1000ms TTL
    expect(dedup.size).toBe(0);
    expect(await dedup.check("a")).toBeNull();
    dedup.stop();
  });

  it("stop() clears all entries and halts eviction", async () => {
    const dedup = new MessageDeduplicator(1000, 500);
    await dedup.mark("a", "server-a");
    await dedup.mark("b", "server-b");

    dedup.stop();
    expect(dedup.size).toBe(0);
    expect(await dedup.check("a")).toBeNull();

    // Advancing past the evict interval after stop() must not throw
    vi.advanceTimersByTime(10_000);
    expect(dedup.size).toBe(0);
  });
});
