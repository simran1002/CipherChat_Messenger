import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Socket as ClientSocket } from "socket.io-client";
import { startDb, stopDb } from "../helpers/db.js";
import {
  connectClient,
  createUserWithToken,
  startTestServer,
  type TestServer,
} from "../helpers/testServer.js";
import { Chatroom } from "../../src/models/Chatroom.js";
import { Message } from "../../src/models/Message.js";

interface SyncResultItem {
  clientMessageId?: string;
  messageId?: string;
  ok?: boolean;
  duplicate?: boolean;
  error?: string;
}

interface QueueItem {
  chatroomId: string;
  message: string;
  clientMessageId: string;
}

function syncQueue(socket: ClientSocket, messages: QueueItem[]): Promise<SyncResultItem[]> {
  return new Promise((resolve) => {
    socket.once("syncOfflineQueueResult", (p: { results: SyncResultItem[] }) => resolve(p.results));
    socket.emit("syncOfflineQueue", { messages });
  });
}

function makeBatch(chatroomId: string, count: number): QueueItem[] {
  return Array.from({ length: count }, (_, i) => ({
    chatroomId,
    message: `offline message ${i}`,
    clientMessageId: randomUUID(),
  }));
}

describe("offline queue sync (socket integration)", () => {
  let server: TestServer;
  let chatroomId: string;

  beforeAll(async () => {
    await startDb();
    server = await startTestServer();
    const room = await Chatroom.create({ name: `OfflineRoom-${Date.now()}` });
    chatroomId = room.id as string;
  });

  afterAll(async () => {
    await server.close();
    await stopDb();
  });

  it("persists a 3-message batch and reports 3 ok results", async () => {
    const { token } = await createUserWithToken();
    const socket = await connectClient(server.baseUrl, token);
    const batch = makeBatch(chatroomId, 3);

    const results = await syncQueue(socket, batch);

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect(r.messageId).toBeTruthy();
      expect(r.duplicate).toBeUndefined();
    }

    const ids = batch.map((m) => m.clientMessageId);
    const count = await Message.countDocuments({ clientMessageId: { $in: ids } });
    expect(count).toBe(3);
    socket.disconnect();
  });

  it("re-emitting the same batch marks all 3 duplicate with no new rows", async () => {
    const { token } = await createUserWithToken();
    const socket = await connectClient(server.baseUrl, token);
    const batch = makeBatch(chatroomId, 3);

    const first = await syncQueue(socket, batch);
    const second = await syncQueue(socket, batch);

    expect(second).toHaveLength(3);
    for (const r of second) {
      expect(r.duplicate).toBe(true);
      const original = first.find((f) => f.clientMessageId === r.clientMessageId);
      expect(r.messageId).toBe(original?.messageId); // ACKs the original server id
    }

    const ids = batch.map((m) => m.clientMessageId);
    const count = await Message.countDocuments({ clientMessageId: { $in: ids } });
    expect(count).toBe(3); // exactly-once persistence
    socket.disconnect();
  });

  it("caps a batch at 50 items — only the first 50 are processed", async () => {
    const { token } = await createUserWithToken();
    const socket = await connectClient(server.baseUrl, token);
    const batch = makeBatch(chatroomId, 60);

    const results = await syncQueue(socket, batch);
    expect(results).toHaveLength(50);

    const allIds = batch.map((m) => m.clientMessageId);
    const persisted = await Message.countDocuments({ clientMessageId: { $in: allIds } });
    expect(persisted).toBe(50);

    // Specifically, items 50..59 were dropped
    const overflowIds = allIds.slice(50);
    const overflowPersisted = await Message.countDocuments({ clientMessageId: { $in: overflowIds } });
    expect(overflowPersisted).toBe(0);
    socket.disconnect();
  });
});
