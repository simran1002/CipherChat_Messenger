import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, stopDb } from "../helpers/db.js";
import { createUserWithToken, startTestServer, type TestServer } from "../helpers/testServer.js";
import { Chatroom } from "../../src/models/Chatroom.js";
import { Message } from "../../src/models/Message.js";

describe("chatroom REST endpoints", () => {
  let server: TestServer;
  let owner: { userId: string; token: string };
  let other: { userId: string; token: string };

  beforeAll(async () => {
    await startDb();
    server = await startTestServer();
    owner = await createUserWithToken("Room Owner");
    other = await createUserWithToken("Room Other");
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

  it("creates a chatroom: 200 with the saved room", async () => {
    const name = `RestRoom-${Date.now()}`;
    const res = await api("/chatroom", { method: "POST", token: owner.token, body: { name } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chatroom: { _id: string; name: string } };
    expect(body.chatroom.name).toBe(name);
    expect(body.chatroom._id).toBeTruthy();
  });

  it("rejects a duplicate name (case-insensitive) with 409", async () => {
    const name = `DupRoom-${Date.now()}`;
    expect((await api("/chatroom", { method: "POST", token: owner.token, body: { name } })).status).toBe(200);

    const dup = await api("/chatroom", {
      method: "POST",
      token: owner.token,
      body: { name: name.toUpperCase() },
    });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { code: string }).code).toBe("chatroom_exists");
  });

  it("rejects invalid characters in the name with 400", async () => {
    const res = await api("/chatroom", {
      method: "POST",
      token: owner.token,
      body: { name: "bad!name$<script>" },
    });
    expect(res.status).toBe(400);
  });

  it("returns cursor-paginated messages with the documented shape", async () => {
    const room = await Chatroom.create({ name: `PageRoom-${Date.now()}` });
    for (let i = 0; i < 3; i++) {
      await Message.create({
        chatroom: room.id,
        user: owner.userId,
        message: `paged message ${i}`,
        sequenceNumber: i + 1,
      });
    }

    const res = await api(`/chatroom/${room.id}/messages?limit=2`, { token: owner.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ message: string; sequenceNumber: number; user: { name: string } }>;
      chatroom: { name: string; id: string };
      cursor: { nextCursor: string | null; hasMore: boolean; limit: number };
    };
    // Newest page, ascending → seq 2,3; cursor points at the oldest returned row
    expect(body.messages.map((m) => m.sequenceNumber)).toEqual([2, 3]);
    expect(body.chatroom.name).toBe(room.name);
    expect(body.cursor).toEqual({ nextCursor: expect.any(String), hasMore: true, limit: 2 });
  });

  it("search with regex metacharacters returns 200 and [] (ReDoS guard)", async () => {
    const room = await Chatroom.create({ name: `SearchRoom-${Date.now()}` });
    await Message.create({
      chatroom: room.id,
      user: owner.userId,
      message: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sequenceNumber: 1,
    });

    const q = encodeURIComponent("(a+)+$");
    const res = await api(`/chatroom/${room.id}/messages/search?q=${q}`, { token: owner.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[]; query: string };
    expect(body.messages).toEqual([]); // treated as a literal string, not a regex
    expect(body.query).toBe("(a+)+$");
  });

  it("search still matches literal text", async () => {
    const room = await Chatroom.create({ name: `SearchRoom2-${Date.now()}` });
    await Message.create({
      chatroom: room.id,
      user: owner.userId,
      message: "the secret launch code",
      sequenceNumber: 1,
    });

    const res = await api(`/chatroom/${room.id}/messages/search?q=launch`, { token: owner.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ message: string }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.message).toBe("the secret launch code");
  });

  it("edit by a non-owner is 403", async () => {
    const room = await Chatroom.create({ name: `EditRoom-${Date.now()}` });
    const msg = await Message.create({
      chatroom: room.id,
      user: owner.userId,
      message: "owner's message",
      sequenceNumber: 1,
    });

    const res = await api(`/chatroom/messages/${msg.id}`, {
      method: "PUT",
      token: other.token,
      body: { message: "hijacked" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("not_owner");

    const unchanged = await Message.findById(msg.id);
    expect(unchanged?.message).toBe("owner's message");
  });

  it("delete by a non-owner is 403", async () => {
    const room = await Chatroom.create({ name: `DeleteRoom-${Date.now()}` });
    const msg = await Message.create({
      chatroom: room.id,
      user: owner.userId,
      message: "do not delete",
      sequenceNumber: 1,
    });

    const res = await api(`/chatroom/messages/${msg.id}`, { method: "DELETE", token: other.token });
    expect(res.status).toBe(403);
    expect(await Message.findById(msg.id)).not.toBeNull();
  });
});
