import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageDelivery, type SendResult } from "./useMessageDelivery";
import { enqueue } from "../services/OfflineQueue";
import type { AppSocket, ChatroomMessagePayload, MessageAck } from "../types";

vi.mock("../services/OfflineQueue", () => ({
  enqueue: vi.fn(() => Promise.resolve(1)),
}));

const enqueueMock = vi.mocked(enqueue);

type EmitCallback = (err: Error | null, ack?: MessageAck) => void;
type EmitFn = (event: string, payload: ChatroomMessagePayload, cb: EmitCallback) => void;

function makeSocket(connected: boolean) {
  const emit = vi.fn<EmitFn>();
  const timeout = vi.fn(() => ({ emit }));
  const socket = { connected, timeout } as unknown as AppSocket;
  return { socket, emit, timeout };
}

describe("useMessageDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queues to OfflineQueue when the socket is offline", async () => {
    const { socket, emit } = makeSocket(false);
    const { result } = renderHook(() => useMessageDelivery(socket, "room-1"));

    const res = await result.current.send({ message: "hello offline" });

    expect(res).toMatchObject({ queued: true });
    expect(emit).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledTimes(1);

    const item = enqueueMock.mock.calls[0][0];
    expect(item.kind).toBe("chatroom");
    expect(item.targetId).toBe("room-1");
    expect(item.payload).toMatchObject({ message: "hello offline" });
    expect(item.clientMessageId).toEqual(expect.any(String));
    if (!("queued" in res)) throw new Error("expected queued result");
    expect(res.clientMessageId).toBe(item.clientMessageId);
  });

  it("resolves ok on a successful ack and clears pending", async () => {
    const { socket, emit } = makeSocket(true);
    emit.mockImplementation((_event, _payload, cb) => {
      cb(null, { ok: true, messageId: "srv-1" });
    });
    const { result } = renderHook(() => useMessageDelivery(socket, "room-1"));

    let res!: SendResult;
    await act(async () => {
      res = await result.current.send({ message: "hi" });
    });

    expect(res).toMatchObject({ ok: true, messageId: "srv-1" });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "chatroomMessage",
      expect.objectContaining({ chatroomId: "room-1", message: "hi" }),
      expect.any(Function)
    );
    expect(result.current.pendingCount).toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("resolves with rate_limited error when the server rejects", async () => {
    const { socket, emit } = makeSocket(true);
    emit.mockImplementation((_event, _payload, cb) => {
      cb(null, { ok: false, error: "rate_limited" });
    });
    const { result } = renderHook(() => useMessageDelivery(socket, "room-1"));

    let res!: SendResult;
    await act(async () => {
      res = await result.current.send({ message: "spam" });
    });

    expect(res).toEqual({ ok: false, error: "rate_limited" });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(result.current.pendingCount).toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("retries with exponential backoff on timeout, then falls back to the offline queue", async () => {
    vi.useFakeTimers();
    const { socket, emit } = makeSocket(true);
    emit.mockImplementation((_event, _payload, cb) => {
      cb(new Error("operation has timed out"));
    });
    const { result } = renderHook(() => useMessageDelivery(socket, "room-1"));

    let sendPromise!: Promise<SendResult>;
    act(() => {
      sendPromise = result.current.send({ message: "flaky network" });
    });

    // Initial attempt fires synchronously.
    expect(emit).toHaveBeenCalledTimes(1);

    // Backoff delays are 1s/2s/4s/8s with up to +20% jitter — advance generously.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(emit).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(emit).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(emit).toHaveBeenCalledTimes(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(emit).toHaveBeenCalledTimes(5); // initial + 4 retries

    const res = await sendPromise;
    expect(res).toMatchObject({ queued: true });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0]).toMatchObject({
      kind: "chatroom",
      targetId: "room-1",
      payload: { message: "flaky network" },
    });
    expect(result.current.pendingCount).toBe(0);
  });

  it("preserves a caller-supplied clientMessageId", async () => {
    const { socket, emit } = makeSocket(true);
    emit.mockImplementation((_event, _payload, cb) => {
      cb(null, { ok: true, messageId: "srv-2" });
    });
    const { result } = renderHook(() => useMessageDelivery(socket, "room-1"));

    let res!: SendResult;
    await act(async () => {
      res = await result.current.send({ message: "resend", clientMessageId: "custom-123" });
    });

    expect(res).toMatchObject({ ok: true, clientMessageId: "custom-123" });
    expect(emit.mock.calls[0][1].clientMessageId).toBe("custom-123");
  });
});
