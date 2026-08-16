// fake-indexeddb must install its global `indexedDB` BEFORE the module under
// test opens its cached DB handle — keep this import first.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clear, drain, drainDms, enqueue, getAll, remove } from "./OfflineQueue";
import type { AppSocket, DmMessageAck } from "../types";

type ResultsPayload = {
  results: Array<{ clientMessageId?: string; ok?: boolean; duplicate?: boolean }>;
};

function makeDrainSocket() {
  const captured: { handler?: (p: ResultsPayload) => unknown } = {};
  const emit = vi.fn();
  const once = vi.fn((_event: string, handler: (p: ResultsPayload) => unknown) => {
    captured.handler = handler;
  });
  const off = vi.fn();
  const socket = { emit, once, off } as unknown as AppSocket;
  return { socket, emit, once, off, captured };
}

const chatroomItem = (targetId: string, message: string, clientMessageId: string) => ({
  kind: "chatroom" as const,
  targetId,
  clientMessageId,
  payload: { message },
});

describe("OfflineQueue", () => {
  afterEach(async () => {
    // The module caches its DB handle; clearing the store keeps tests isolated.
    await clear();
    vi.restoreAllMocks();
  });

  it("enqueue assigns incrementing ids and stamps queuedAt", async () => {
    const before = Date.now();
    const id1 = await enqueue(chatroomItem("r1", "first", "c1"));
    const id2 = await enqueue(chatroomItem("r1", "second", "c2"));

    expect(typeof id1).toBe("number");
    expect(id2).toBe(id1 + 1);

    const items = await getAll();
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(typeof item.queuedAt).toBe("number");
      expect(item.queuedAt).toBeGreaterThanOrEqual(before);
    }
  });

  it("getAll returns the inserted items", async () => {
    await enqueue(chatroomItem("r1", "one", "c1"));
    await enqueue(chatroomItem("r2", "two", "c2"));

    const items = await getAll();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "chatroom", targetId: "r1", clientMessageId: "c1" });
    expect(items[0]?.payload).toMatchObject({ message: "one" });
    expect(items[1]).toMatchObject({ kind: "chatroom", targetId: "r2", clientMessageId: "c2" });
  });

  it("remove deletes a single item by id", async () => {
    const id1 = await enqueue(chatroomItem("r1", "keep", "c1"));
    const id2 = await enqueue(chatroomItem("r1", "drop", "c2"));

    await remove(id2);

    const items = await getAll();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(id1);
    expect(items[0]?.payload).toMatchObject({ message: "keep" });
  });

  it("clear empties the store", async () => {
    await enqueue(chatroomItem("r1", "a", "c1"));
    await enqueue(chatroomItem("r1", "b", "c2"));

    await clear();

    expect(await getAll()).toEqual([]);
  });

  it("drain emits syncOfflineQueue for chatroom items and removes only the confirmed ones", async () => {
    await enqueue(chatroomItem("r1", "m1", "c1"));
    await enqueue(chatroomItem("r1", "m2", "c2"));
    await enqueue(chatroomItem("r2", "m3", "c3"));

    const { socket, emit, once, off, captured } = makeDrainSocket();
    const drainPromise = drain(socket);

    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
    expect(once).toHaveBeenCalledWith("syncOfflineQueueResult", expect.any(Function));
    expect(emit).toHaveBeenCalledWith("syncOfflineQueue", {
      messages: [
        { chatroomId: "r1", message: "m1", clientMessageId: "c1" },
        { chatroomId: "r1", message: "m2", clientMessageId: "c2" },
        { chatroomId: "r2", message: "m3", clientMessageId: "c3" },
      ],
    });

    expect(captured.handler).toBeDefined();
    // Server confirms c1 (ok) and c3 (duplicate); c2 failed and must remain.
    await captured.handler!({
      results: [
        { clientMessageId: "c1", ok: true },
        { clientMessageId: "c2", ok: false },
        { clientMessageId: "c3", duplicate: true },
      ],
    });
    await drainPromise;

    const remaining = await getAll();
    expect(remaining.map((i) => i.clientMessageId)).toEqual(["c2"]);
    expect(off).toHaveBeenCalledWith("syncOfflineQueueResult", expect.any(Function));
  });

  it("drain with an empty queue emits nothing", async () => {
    const { socket, emit, once } = makeDrainSocket();

    await drain(socket);

    expect(emit).not.toHaveBeenCalled();
    expect(once).not.toHaveBeenCalled();
  });

  it("drain ignores dm-kind items (they drain separately via drainDms)", async () => {
    await enqueue({ kind: "dm", targetId: "conv1", clientMessageId: "d1", payload: { message: "hi" } });
    const { socket, emit } = makeDrainSocket();

    await drain(socket);

    expect(emit).not.toHaveBeenCalled();
    expect(await getAll()).toHaveLength(1); // untouched
  });
});

describe("OfflineQueue.drainDms", () => {
  afterEach(async () => {
    await clear();
    vi.restoreAllMocks();
  });

  function makeDmSocket(acks: DmMessageAck[]) {
    let call = 0;
    const emit = vi.fn(
      (
        _event: string,
        _payload: unknown,
        cb: (err: Error | null, ack?: DmMessageAck) => void
      ) => {
        cb(null, acks[call++]);
      }
    );
    const socket = { timeout: vi.fn(() => ({ emit })) } as unknown as AppSocket;
    return { socket, emit };
  }

  it("replays queued DM sends sequentially and removes acked/duplicate items", async () => {
    await enqueue({ kind: "dm", targetId: "conv1", clientMessageId: "d1", payload: { message: "hello" } });
    await enqueue({ kind: "dm", targetId: "conv1", clientMessageId: "d2", payload: { envelope: { v: 1, sessionId: "s", ctr: 0, ct: "xx" } } });

    const { socket, emit } = makeDmSocket([
      { ok: true, messageId: "m1" },
      { ok: true, messageId: "m2", duplicate: true },
    ]);

    await drainDms(socket);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(await getAll()).toHaveLength(0);
  });

  it("keeps items whose ack failed", async () => {
    await enqueue({ kind: "dm", targetId: "conv1", clientMessageId: "d1", payload: { message: "hello" } });
    const { socket } = makeDmSocket([{ ok: false, error: "server_error" }]);

    await drainDms(socket);

    const remaining = await getAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.clientMessageId).toBe("d1");
  });
});
