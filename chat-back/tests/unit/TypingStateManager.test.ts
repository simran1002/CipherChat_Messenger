import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TypingStateManager } from "../../src/shared/TypingStateManager.js";

describe("TypingStateManager (TTL typing state)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the expiry handler with room, user and cluster scope after the TTL", () => {
    const mgr = new TypingStateManager(1000);
    const onExpire = vi.fn();
    mgr.onExpire(onExpire);

    mgr.start("room-1", "user-1", "Alice");
    vi.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire).toHaveBeenCalledWith("room-1", "user-1", "cluster");
  });

  it("restarts the TTL on repeated start() — no premature expiry", () => {
    const mgr = new TypingStateManager(1000);
    const onExpire = vi.fn();
    mgr.onExpire(onExpire);

    mgr.start("room-1", "user-1", "Alice");
    vi.advanceTimersByTime(600);
    mgr.start("room-1", "user-1", "Alice"); // keystroke — reset TTL

    vi.advanceTimersByTime(600); // 1200ms total, but only 600ms into new TTL
    expect(onExpire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(onExpire).toHaveBeenCalledTimes(1); // exactly once, from the restart
  });

  it("stop() cancels the pending expiry", () => {
    const mgr = new TypingStateManager(1000);
    const onExpire = vi.fn();
    mgr.onExpire(onExpire);

    mgr.start("room-1", "user-1", "Alice");
    mgr.stop("room-1", "user-1");

    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("clearUser() clears the user's state across all rooms", () => {
    const mgr = new TypingStateManager(1000);
    const onExpire = vi.fn();
    mgr.onExpire(onExpire);

    mgr.start("room-a", "user-1", "Alice");
    mgr.start("room-b", "user-1", "Alice");
    mgr.start("room-a", "user-2", "Bob");

    mgr.clearUser("user-1"); // e.g. socket disconnect

    vi.advanceTimersByTime(5000);
    expect(onExpire).toHaveBeenCalledTimes(1); // other users unaffected
    expect(onExpire).toHaveBeenCalledWith("room-a", "user-2", "cluster");
  });

  it("dispose() cancels everything", () => {
    const mgr = new TypingStateManager(1000);
    const onExpire = vi.fn();
    mgr.onExpire(onExpire);

    mgr.start("room-a", "user-1", "Alice");
    mgr.start("room-b", "user-2", "Bob");
    mgr.dispose();

    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
