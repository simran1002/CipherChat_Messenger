import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresenceHeartbeat } from "../../src/shared/PresenceHeartbeat.js";

describe("PresenceHeartbeat (TTL presence tracker)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onOffline after missThreshold missed intervals", () => {
    const hb = new PresenceHeartbeat(1000, 2);
    const onOffline = vi.fn();

    hb.beat("user-1", onOffline);
    vi.advanceTimersByTime(1000); // miss 1
    expect(onOffline).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000); // miss 2 → threshold
    expect(onOffline).toHaveBeenCalledTimes(1);
    expect(onOffline).toHaveBeenCalledWith("user-1");

    // Entry is cleared after firing — never fires twice
    vi.advanceTimersByTime(10_000);
    expect(onOffline).toHaveBeenCalledTimes(1);
  });

  it("refresh() resets the miss count", () => {
    const hb = new PresenceHeartbeat(1000, 2);
    const onOffline = vi.fn();

    hb.beat("user-1", onOffline);
    vi.advanceTimersByTime(1000); // miss 1
    hb.refresh("user-1"); // ping arrived — back to 0 misses

    vi.advanceTimersByTime(1000); // miss 1 again
    expect(onOffline).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000); // miss 2 → offline
    expect(onOffline).toHaveBeenCalledTimes(1);
  });

  it("clear() cancels tracking for a user", () => {
    const hb = new PresenceHeartbeat(1000, 2);
    const onOffline = vi.fn();

    hb.beat("user-1", onOffline);
    hb.clear("user-1");

    vi.advanceTimersByTime(10_000);
    expect(onOffline).not.toHaveBeenCalled();
  });

  it("stopAll() cancels every tracked user", () => {
    const hb = new PresenceHeartbeat(1000, 2);
    const offline1 = vi.fn();
    const offline2 = vi.fn();

    hb.beat("user-1", offline1);
    hb.beat("user-2", offline2);
    hb.stopAll();

    vi.advanceTimersByTime(10_000);
    expect(offline1).not.toHaveBeenCalled();
    expect(offline2).not.toHaveBeenCalled();
  });
});
