import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RosterBroadcaster } from "../../src/shared/RosterBroadcaster.js";

describe("RosterBroadcaster (throttled presence fan-out)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires immediately when idle — small rooms stay snappy", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const rb = new RosterBroadcaster(send, 1000);
    rb.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst into one leading + one trailing broadcast", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const rb = new RosterBroadcaster(send, 1000);

    // 500 "connects" in one throttle window — the ramp scenario
    for (let i = 0; i < 500; i++) rb.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1); // leading edge only

    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2); // one trailing broadcast for all 500

    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(2); // quiet after — no periodic spam
  });

  it("a request during the trailing window schedules exactly one more", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const rb = new RosterBroadcaster(send, 1000);

    rb.request(); // leading
    await vi.advanceTimersByTimeAsync(0);
    rb.request(); // dirty → trailing at t=1000
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);

    rb.request(); // during the NEW cooldown → trailing at t=2000
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("a failing send never breaks the throttle", async () => {
    const send = vi.fn().mockRejectedValue(new Error("emit failed"));
    const rb = new RosterBroadcaster(send, 1000);
    rb.request();
    rb.request();
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledTimes(2); // leading + trailing, no unhandled rejection

    send.mockResolvedValue(undefined);
    rb.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(3); // still operational
  });

  it("dispose cancels the pending trailing broadcast", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const rb = new RosterBroadcaster(send, 1000);
    rb.request();
    rb.request();
    await vi.advanceTimersByTimeAsync(0);
    rb.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
