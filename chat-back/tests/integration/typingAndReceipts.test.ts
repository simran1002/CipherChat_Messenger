import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
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

interface Ack {
  ok: boolean;
  messageId?: string;
  sequenceNumber?: number;
}

function emitMessage(socket: ClientSocket, payload: Record<string, unknown>): Promise<Ack> {
  return new Promise((resolve) => {
    socket.emit("chatroomMessage", payload, (ack: Ack) => resolve(ack));
  });
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("typing indicators and receipts (socket integration)", () => {
  let server: TestServer;
  const openSockets: ClientSocket[] = [];

  beforeAll(async () => {
    await startDb();
    server = await startTestServer();
  });

  afterEach(() => {
    for (const s of openSockets.splice(0)) s.disconnect();
  });

  afterAll(async () => {
    await server.close();
    await stopDb();
  });

  /** Two authenticated clients joined to a fresh room, presence settled. */
  async function twoClientsInRoom(): Promise<{
    chatroomId: string;
    alice: { userId: string; socket: ClientSocket };
    bob: { userId: string; socket: ClientSocket };
  }> {
    const room = await Chatroom.create({ name: `ReceiptRoom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
    const chatroomId = room.id as string;

    const aliceUser = await createUserWithToken("Alice Typing");
    const bobUser = await createUserWithToken("Bob Typing");
    const aliceSocket = await connectClient(server.baseUrl, aliceUser.token);
    const bobSocket = await connectClient(server.baseUrl, bobUser.token);
    openSockets.push(aliceSocket, bobSocket);

    aliceSocket.emit("joinRoom", { chatroomId });
    bobSocket.emit("joinRoom", { chatroomId });
    await wait(200); // let joins land and presence registry settle

    return {
      chatroomId,
      alice: { userId: aliceUser.userId, socket: aliceSocket },
      bob: { userId: bobUser.userId, socket: bobSocket },
    };
  }

  it("relays typing, then auto-emits userStopTyping after the 4s TTL", async () => {
    const { chatroomId, alice, bob } = await twoClientsInRoom();

    const typingP = new Promise<{ userId: string; name: string }>((resolve) => {
      bob.socket.once("userTyping", resolve);
    });
    const stopP = new Promise<{ userId: string }>((resolve) => {
      bob.socket.once("userStopTyping", resolve);
    });

    alice.socket.emit("typing", { chatroomId });

    const typing = await typingP;
    expect(typing.userId).toBe(alice.userId);
    expect(typing.name).toBe("Alice Typing");

    // No stopTyping is ever emitted by the client — the TTL (4s) must expire it
    const stopped = await stopP;
    expect(stopped.userId).toBe(alice.userId);
  });

  it("markRead updates readBy in the DB and broadcasts messagesRead", async () => {
    const { chatroomId, alice, bob } = await twoClientsInRoom();

    const ack = await emitMessage(alice.socket, {
      chatroomId,
      message: "read me",
      clientMessageId: randomUUID(),
    });
    expect(ack.ok).toBe(true);

    const readP = new Promise<{ userId: string; chatroomId: string }>((resolve) => {
      alice.socket.once("messagesRead", resolve);
    });

    bob.socket.emit("markRead", { chatroomId });

    const readEvent = await readP;
    expect(readEvent.userId).toBe(bob.userId);
    expect(readEvent.chatroomId).toBe(chatroomId);

    const saved = await Message.findById(ack.messageId);
    const readers = saved?.readBy.map((r) => r.user?.toString());
    expect(readers).toContain(bob.userId);
  });

  it("messageDelivered updates deliveredTo and broadcasts messageDeliveryUpdate", async () => {
    const { chatroomId, alice, bob } = await twoClientsInRoom();

    const ack = await emitMessage(alice.socket, {
      chatroomId,
      message: "deliver me",
      clientMessageId: randomUUID(),
    });
    expect(ack.ok).toBe(true);

    const updateP = new Promise<{ messageId: string; deliveredTo: string[] }>((resolve) => {
      alice.socket.once("messageDeliveryUpdate", resolve);
    });

    bob.socket.emit("messageDelivered", { messageId: ack.messageId, chatroomId });

    const update = await updateP;
    expect(update.messageId).toBe(ack.messageId);
    expect(update.deliveredTo).toContain(bob.userId);
    expect(update.deliveredTo).toContain(alice.userId); // sender is pre-seeded

    const saved = await Message.findById(ack.messageId);
    expect(saved?.deliveredTo.map((id) => id.toString())).toContain(bob.userId);
  });
});
