import { describe, expect, it, vi } from "vitest";
import { SequenceCounter } from "../../src/shared/SequenceCounter.js";

describe("SequenceCounter (per-room monotonic)", () => {
  it("next() is strictly monotonic within a room", async () => {
    const counter = new SequenceCounter();
    expect(await counter.next("room-1")).toBe(1);
    expect(await counter.next("room-1")).toBe(2);
    expect(await counter.next("room-1")).toBe(3);
  });

  it("keeps independent counters per room", async () => {
    const counter = new SequenceCounter();
    await counter.next("room-a");
    await counter.next("room-a");
    expect(await counter.next("room-b")).toBe(1); // untouched by room-a
    expect(await counter.next("room-a")).toBe(3);
  });

  it("current() reads without incrementing", async () => {
    const counter = new SequenceCounter();
    expect(await counter.current("room-1")).toBe(0);
    await counter.next("room-1");
    expect(await counter.current("room-1")).toBe(1);
    expect(await counter.current("room-1")).toBe(1); // still 1 — no side effect
  });

  it("seeds from the provided source — restart recovery", async () => {
    const counter = new SequenceCounter(async () => 41);
    expect(await counter.next("room-1")).toBe(42);
    expect(await counter.next("room-1")).toBe(43);
  });

  it("calls the seed function only once per room", async () => {
    const seed = vi.fn(async () => 10);
    const counter = new SequenceCounter(seed);

    await counter.next("room-1");
    await counter.next("room-1");
    await counter.current("room-1");
    expect(seed).toHaveBeenCalledTimes(1);

    await counter.next("room-2");
    expect(seed).toHaveBeenCalledTimes(2);
    expect(seed).toHaveBeenLastCalledWith("room-2");
  });
});

describe("SequenceCounter — concurrency", () => {
  it("issues strictly unique numbers under concurrent fire on a cold room", async () => {
    // Slow seed widens the race window an earlier version lost: concurrent
    // callers interleaved read→await→write and drew duplicate numbers.
    const counter = new SequenceCounter(
      () => new Promise((r) => setTimeout(() => r(100), 20))
    );
    const results = await Promise.all(Array.from({ length: 50 }, () => counter.next("cold-room")));
    expect(new Set(results).size).toBe(50);
    expect(Math.min(...results)).toBe(101);
    expect(Math.max(...results)).toBe(150);
  });

  it("seed source is called exactly once per room even under concurrency", async () => {
    let calls = 0;
    const counter = new SequenceCounter(async () => { calls++; return 0; });
    await Promise.all(Array.from({ length: 20 }, () => counter.next("one-seed")));
    expect(calls).toBe(1);
  });
});
