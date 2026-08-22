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
import { RoomReadState } from "../../src/models/RoomReadState.js";
import type { Socket as ClientSocket } from "socket.io-client";

interface Ack {
  ok: boolean;
  messageId?: string;
  sequenceNumber?: number;
  duplicate?: boolean;
  error?: string;
}

interface CursorPage {
  messages: Array<{ _id: string; message: string; sequenceNumber: number }>;
  chatroom: { name: string; id: string; isPrivate: boolean };
  cursor: { nextCursor: string | null; hasMore: boolean; limit: number };
}

interface RoomListEntry {
  _id: string;
  unreadCount: number;
  myRole: string | null;
}

function emitMessage(socket: ClientSocket, payload: Record<string, unknown>): Promise<Ack> {
  return new Promise((resolve) => {
    socket.emit("chatroomMessage", payload, (ack: Ack) => resolve(ack));
  });
}

function onceEvent<T>(socket: ClientSocket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Poll until an async condition holds (socket handlers have no ack for these paths). */
async function waitUntil(cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitUntil: condition not met in time");
}

/** Seed `count` sequential messages from `userId` into a room, directly in Mongo. */
async function seedMessages(chatroomId: string, userId: string, count: number) {
  const docs = [];
  const base = Date.now() - count * 1000;
  for (let i = 1; i <= count; i++) {
    docs.push({
      chatroom: chatroomId,
      user: userId,
      message: `seeded ${i}`,
      sequenceNumber: i,
      // Distinct createdAt per row — the legacy endpoint sorts on createdAt,
      // which only has millisecond resolution (bulk-created rows would tie)
      createdAt: new Date(base + i * 1000),
    });
  }
  // Message.create(array) keeps insertion order, so _ids ascend with sequenceNumber
  return Message.create(docs);
}

describe("cursor pagination, unread counts, and mentions", () => {
  let server: TestServer;

  beforeAll(async () => {
    await startDb();
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
    await stopDb();
  });

  function api(
    path: string,
    opts: { method?: string; token?: string; body?: Record<string, unknown> } = {}
  ): Promise<Response> {
    return fetch(`${server.baseUrl}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  }

  async function unreadCount(token: string, roomId: string): Promise<number> {
    const rooms = (await (await api("/chatroom", { token })).json()) as RoomListEntry[];
    const room = rooms.find((r) => r._id === roomId);
    expect(room).toBeTruthy();
    return room!.unreadCount;
  }

  // ── Cursor pagination ───────────────────────────────────────────────────────

  it("pages 120 messages newest-first in 50s via ?before cursors, and keeps the legacy page mode", async () => {
    const userA = await createUserWithToken();
    const room = await Chatroom.create({ name: `CursorRoom-${Date.now()}` });
    const seeded = await seedMessages(room.id as string, userA.userId, 120);
    const idOfSeq = (seq: number) => String(seeded.find((m) => m.sequenceNumber === seq)!._id);

    // Page 1 — no page param means cursor mode: newest 50, ascending
    const res1 = await api(`/chatroom/${room.id}/messages?limit=50`, { token: userA.token });
    expect(res1.status).toBe(200);
    const page1 = (await res1.json()) as CursorPage;
    expect(page1.messages).toHaveLength(50);
    expect(page1.messages.map((m) => m.sequenceNumber)).toEqual(
      Array.from({ length: 50 }, (_, i) => 71 + i)
    );
    expect(page1.cursor.hasMore).toBe(true);
    expect(page1.cursor.nextCursor).toBe(idOfSeq(71));

    // Page 2 — everything older than the seq-71 row
    const res2 = await api(
      `/chatroom/${room.id}/messages?before=${page1.cursor.nextCursor}&limit=50`,
      { token: userA.token }
    );
    const page2 = (await res2.json()) as CursorPage;
    expect(page2.messages.map((m) => m.sequenceNumber)).toEqual(
      Array.from({ length: 50 }, (_, i) => 21 + i)
    );
    expect(page2.cursor.hasMore).toBe(true);
    expect(page2.cursor.nextCursor).toBe(idOfSeq(21));

    // Page 3 — the final 20, no further cursor
    const res3 = await api(
      `/chatroom/${room.id}/messages?before=${page2.cursor.nextCursor}&limit=50`,
      { token: userA.token }
    );
    const page3 = (await res3.json()) as CursorPage;
    expect(page3.messages.map((m) => m.sequenceNumber)).toEqual(
      Array.from({ length: 20 }, (_, i) => 1 + i)
    );
    expect(page3.cursor.hasMore).toBe(false);
    expect(page3.cursor.nextCursor).toBeNull();

    // Legacy offset mode still answers with the old pagination envelope
    const legacyRes = await api(`/chatroom/${room.id}/messages?page=1&limit=50`, {
      token: userA.token,
    });
    expect(legacyRes.status).toBe(200);
    const legacy = (await legacyRes.json()) as {
      messages: Array<{ sequenceNumber: number }>;
      pagination: { page: number; limit: number; total: number; pages: number };
    };
    expect(legacy.pagination).toEqual({ page: 1, limit: 50, total: 120, pages: 3 });
    expect(legacy.messages).toHaveLength(50);
    expect(legacy.messages[0]?.sequenceNumber).toBe(1); // oldest-first in legacy mode
  });

  // ── Unread counts (RoomReadState watermark) ─────────────────────────────────

  it("tracks unread counts through markRead watermarks and the send-path watermark", async () => {
    const userA = await createUserWithToken("Unread A");
    const userB = await createUserWithToken("Unread B");
    const room = await Chatroom.create({ name: `UnreadRoom-${Date.now()}` });
    const roomId = room.id as string;
    await seedMessages(roomId, userA.userId, 120);

    // B has read nothing: all 120 of A's messages are unread
    expect(await unreadCount(userB.token, roomId)).toBe(120);
    // A sent every seeded message — own messages never count as unread
    expect(await unreadCount(userA.token, roomId)).toBe(0);

    // B reads up to sequence 100 via the socket watermark
    const socketB = await connectClient(server.baseUrl, userB.token);
    socketB.emit("markRead", { chatroomId: roomId, upToSequence: 100 });
    await waitUntil(async () => {
      const state = await RoomReadState.findOne({ user: userB.userId, chatroom: roomId }).lean();
      return (state?.lastReadSequence ?? 0) >= 100;
    });
    expect(await unreadCount(userB.token, roomId)).toBe(20);

    // B posts — seq 121 — which A has not read
    const bAck = await emitMessage(socketB, {
      chatroomId: roomId,
      message: "b speaks",
      clientMessageId: randomUUID(),
    });
    expect(bAck.ok).toBe(true);
    expect(bAck.sequenceNumber).toBe(121);
    expect(await unreadCount(userA.token, roomId)).toBe(1);

    // A replies — seq 122 — and sending advances A's own watermark past B's message
    const socketA = await connectClient(server.baseUrl, userA.token);
    const aAck = await emitMessage(socketA, {
      chatroomId: roomId,
      message: "a replies",
      clientMessageId: randomUUID(),
    });
    expect(aAck.ok).toBe(true);
    expect(aAck.sequenceNumber).toBe(122);
    await waitUntil(async () => {
      const state = await RoomReadState.findOne({ user: userA.userId, chatroom: roomId }).lean();
      return (state?.lastReadSequence ?? 0) >= 122;
    });
    expect(await unreadCount(userA.token, roomId)).toBe(0);

    // B reads to the latest — both sides settle at zero
    socketB.emit("markRead", { chatroomId: roomId, upToSequence: 122 });
    await waitUntil(async () => {
      const state = await RoomReadState.findOne({ user: userB.userId, chatroom: roomId }).lean();
      return (state?.lastReadSequence ?? 0) >= 122;
    });
    expect(await unreadCount(userB.token, roomId)).toBe(0);
    expect(await unreadCount(userA.token, roomId)).toBe(0);

    socketA.disconnect();
    socketB.disconnect();
  });

  // ── Mentions ────────────────────────────────────────────────────────────────

  it("sanitizes mentions (self/dupe/invalid dropped) and notifies exactly the mentioned users", async () => {
    const userA = await createUserWithToken("Mention Sender");
    const userB = await createUserWithToken("Mention B");
    const userC = await createUserWithToken("Mention C");
    const room = await Chatroom.create({
      name: `MentionRoom-${Date.now()}`,
      members: [
        { user: userA.userId, role: "owner" },
        { user: userB.userId, role: "member" },
        { user: userC.userId, role: "member" },
      ],
    });

    const socketA = await connectClient(server.baseUrl, userA.token);
    const socketB = await connectClient(server.baseUrl, userB.token);
    const socketC = await connectClient(server.baseUrl, userC.token);

    // Every connected socket is auto-joined to its `user:<id>` room, so no
    // joinRoom is needed to receive targeted mention notifications.
    interface MentionNote {
      chatroomId: string;
      chatroomName: string;
      messageId: string;
      from: string;
      preview: string;
    }
    const bNote = onceEvent<MentionNote>(socketB, "mentionNotification");
    const cNote = onceEvent<MentionNote>(socketC, "mentionNotification");
    let senderNotified = false;
    socketA.on("mentionNotification", () => {
      senderNotified = true;
    });

    const text = "heads up @b and @c";
    const ack = await emitMessage(socketA, {
      chatroomId: room.id,
      message: text,
      clientMessageId: randomUUID(),
      mentions: [userB.userId, userC.userId, userA.userId, "not-an-id", userB.userId],
    });
    expect(ack.ok).toBe(true);

    // Persisted mentions: deduped, self and garbage dropped, order kept
    const saved = await Message.findById(ack.messageId).lean();
    expect(saved?.mentions.map((id) => id.toString())).toEqual([userB.userId, userC.userId]);

    const [toB, toC] = await Promise.all([bNote, cNote]);
    for (const note of [toB, toC]) {
      expect(note.from).toBe(userA.name);
      expect(note.chatroomId).toBe(room.id);
      expect(note.messageId).toBe(ack.messageId);
      expect(note.preview).toBe(text);
    }

    await new Promise((r) => setTimeout(r, 300));
    expect(senderNotified).toBe(false); // self-mention was dropped

    socketA.disconnect();
    socketB.disconnect();
    socketC.disconnect();
  });

  it("drops mentions of non-members in a private room", async () => {
    const userA = await createUserWithToken("Private Mentioner");
    const userB = await createUserWithToken("Private Member");
    const outsider = await createUserWithToken("Private Outsider");
    const room = await Chatroom.create({
      name: `PrivMentionRoom-${Date.now()}`,
      isPrivate: true,
      members: [
        { user: userA.userId, role: "owner" },
        { user: userB.userId, role: "member" },
      ],
    });

    const socketA = await connectClient(server.baseUrl, userA.token);
    const outsiderSocket = await connectClient(server.baseUrl, outsider.token);
    let outsiderNotified = false;
    outsiderSocket.on("mentionNotification", () => {
      outsiderNotified = true;
    });

    const ack = await emitMessage(socketA, {
      chatroomId: room.id,
      message: "secret ping",
      clientMessageId: randomUUID(),
      mentions: [userB.userId, outsider.userId],
    });
    expect(ack.ok).toBe(true);

    const saved = await Message.findById(ack.messageId).lean();
    expect(saved?.mentions.map((id) => id.toString())).toEqual([userB.userId]);

    await new Promise((r) => setTimeout(r, 300));
    expect(outsiderNotified).toBe(false);

    socketA.disconnect();
    outsiderSocket.disconnect();
  });
});
