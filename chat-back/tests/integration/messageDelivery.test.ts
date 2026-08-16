import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { startDb, stopDb } from "../helpers/db.js";
import {
  connectClient,
  createUserWithToken,
  startTestServer,
  type TestServer,
} from "../helpers/testServer.js";
import { Chatroom } from "../../src/models/Chatroom.js";
import { Message } from "../../src/models/Message.js";
import type { Socket as ClientSocket } from "socket.io-client";

interface Ack {
  ok: boolean;
  messageId?: string;
  sequenceNumber?: number;
  duplicate?: boolean;
  error?: string;
}

function emitMessage(socket: ClientSocket, payload: Record<string, unknown>): Promise<Ack> {
  return new Promise((resolve) => {
    socket.emit("chatroomMessage", payload, (ack: Ack) => resolve(ack));
  });
}

describe("message delivery pipeline (socket integration)", () => {
  let server: TestServer;
  let chatroomId: string;

  beforeAll(async () => {
    await startDb();
    server = await startTestServer();
    const room = await Chatroom.create({ name: `DeliveryRoom-${Date.now()}` });
    chatroomId = room.id as string;
  });

  afterAll(async () => {
    await server.close();
    await stopDb();
  });

  it("ACKs a message with a server id and sequence number, and persists it", async () => {
    const { token } = await createUserWithToken();
    const socket = await connectClient(server.baseUrl, token);

    const ack = await emitMessage(socket, {
      chatroomId,
      message: "hello world",
      clientMessageId: randomUUID(),
    });

    expect(ack.ok).toBe(true);
    expect(ack.messageId).toBeTruthy();
    expect(ack.sequenceNumber).toBeGreaterThan(0);

    const saved = await Message.findById(ack.messageId);
    expect(saved?.message).toBe("hello world");
    socket.disconnect();
  });

  it("deduplicates a retried clientMessageId — exactly-once persistence", async () => {
    const { token } = await createUserWithToken();
    const socket = await connectClient(server.baseUrl, token);
    const clientMessageId = randomUUID();

    const first = await emitMessage(socket, { chatroomId, message: "retry me", clientMessageId });
    const second = await emitMessage(socket, { chatroomId, message: "retry me", clientMessageId });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.messageId).toBe(first.messageId);

    const count = await Message.countDocuments({ clientMessageId });
    expect(count).toBe(1);
    socket.disconnect();
  });

  it("assigns strictly increasing sequence numbers per room", async () => {
    const { token } = await createUserWithToken();
    const socket = await connectClient(server.baseUrl, token);

    const acks: Ack[] = [];
    for (let i = 0; i < 3; i++) {
      acks.push(await emitMessage(socket, { chatroomId, message: `seq ${i}`, clientMessageId: randomUUID() }));
    }
    const seqs = acks.map((a) => a.sequenceNumber!);
    expect(seqs[1]).toBe(seqs[0]! + 1);
    expect(seqs[2]).toBe(seqs[1]! + 1);
    socket.disconnect();
  });

  it("broadcasts newMessage to other members of the room", async () => {
    const alice = await createUserWithToken("Alice");
    const bob = await createUserWithToken("Bob");
    const aliceSocket = await connectClient(server.baseUrl, alice.token);
    const bobSocket = await connectClient(server.baseUrl, bob.token);

    aliceSocket.emit("joinRoom", { chatroomId });
    bobSocket.emit("joinRoom", { chatroomId });
    await new Promise((r) => setTimeout(r, 150)); // let joins land

    const received = new Promise<{ message: string; name: string }>((resolve) => {
      bobSocket.once("newMessage", resolve);
    });

    await emitMessage(aliceSocket, { chatroomId, message: "hi bob", clientMessageId: randomUUID() });

    const msg = await received;
    expect(msg.message).toBe("hi bob");
    expect(msg.name).toBe("Alice");

    aliceSocket.disconnect();
    bobSocket.disconnect();
  });

  it("rejects unauthenticated socket connections", async () => {
    await expect(connectClient(server.baseUrl, "not-a-real-token")).rejects.toThrow(/invalid token/i);
  });

  it("rate-limits a flood and reports rate_limited in the ack", async () => {
    const { token } = await createUserWithToken();
    const socket = await connectClient(server.baseUrl, token);

    // Capacity is 20 with 2/s refill — fire 30 as fast as possible
    const acks = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        emitMessage(socket, { chatroomId, message: `flood ${i}`, clientMessageId: randomUUID() })
      )
    );

    const limited = acks.filter((a) => a.error === "rate_limited");
    const accepted = acks.filter((a) => a.ok);
    expect(limited.length).toBeGreaterThan(0);
    expect(accepted.length).toBeGreaterThan(0);
    expect(limited.length + accepted.length).toBe(30);
    socket.disconnect();
  });
});
