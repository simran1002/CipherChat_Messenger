import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../../src/shared/RateLimiter.js";

describe("RateLimiter (token bucket)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows a burst up to capacity, then rejects", async () => {
    const rl = new RateLimiter(5, 1, 1);
    for (let i = 0; i < 5; i++) {
      expect(await rl.allow("u1")).toBe(true);
    }
    expect(await rl.allow("u1")).toBe(false);
  });

  it("refills at the configured rate", async () => {
    const rl = new RateLimiter(5, 2, 1); // 2 tokens/sec
    for (let i = 0; i < 5; i++) await rl.allow("u1");
    expect(await rl.allow("u1")).toBe(false);

    vi.advanceTimersByTime(1000); // +2 tokens
    expect(await rl.allow("u1")).toBe(true);
    expect(await rl.allow("u1")).toBe(true);
    expect(await rl.allow("u1")).toBe(false);
  });

  it("never exceeds capacity after a long idle period", async () => {
    const rl = new RateLimiter(3, 10, 1);
    await rl.allow("u1");
    vi.advanceTimersByTime(60_000);
    expect(await rl.allow("u1")).toBe(true);
    expect(await rl.allow("u1")).toBe(true);
    expect(await rl.allow("u1")).toBe(true);
    expect(await rl.allow("u1")).toBe(false); // capped at 3, not 600
  });

  it("isolates buckets per user", async () => {
    const rl = new RateLimiter(1, 1, 1);
    expect(await rl.allow("a")).toBe(true);
    expect(await rl.allow("a")).toBe(false);
    expect(await rl.allow("b")).toBe(true);
  });

  it("clear() resets a user's bucket to full", async () => {
    const rl = new RateLimiter(1, 0.001, 1);
    await rl.allow("u1");
    expect(await rl.allow("u1")).toBe(false);
    await rl.clear("u1");
    expect(await rl.allow("u1")).toBe(true);
  });
});
