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

interface MemberEntry {
  user: { _id: string; name: string } | string;
  role: string;
  joinedAt: string;
}

function emitMessage(socket: ClientSocket, payload: Record<string, unknown>): Promise<Ack> {
  return new Promise((resolve) => {
    socket.emit("chatroomMessage", payload, (ack: Ack) => resolve(ack));
  });
}

function memberUserId(m: MemberEntry): string {
  return typeof m.user === "string" ? m.user : m.user._id;
}

describe("room membership, privacy, and roles", () => {
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

  async function createRoom(
    token: string,
    opts: { isPrivate?: boolean } = {}
  ): Promise<{ id: string; name: string }> {
    const name = `Room-${randomUUID().slice(0, 18)}`;
    const res = await api("/chatroom", {
      method: "POST",
      token,
      body: { name, isPrivate: opts.isPrivate ?? false },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chatroom: { _id: string; name: string } };
    return { id: body.chatroom._id, name: body.chatroom.name };
  }

  async function getMembers(token: string, roomId: string): Promise<{ members: MemberEntry[]; myRole: string | null }> {
    const res = await api(`/chatroom/${roomId}/members`, { token });
    expect(res.status).toBe(200);
    return (await res.json()) as { members: MemberEntry[]; myRole: string | null };
  }

  // ── Private room creation ───────────────────────────────────────────────────

  it("creator of a private room becomes its owner member", async () => {
    const creator = await createUserWithToken();
    const room = await createRoom(creator.token, { isPrivate: true });

    const saved = await Chatroom.findById(room.id);
    expect(saved?.isPrivate).toBe(true);
    expect(saved?.members).toHaveLength(1);
    expect(saved?.members[0]?.user.toString()).toBe(creator.userId);
    expect(saved?.members[0]?.role).toBe("owner");
  });

  it("private room is hidden from non-members' room list but visible to the creator with myRole owner", async () => {
    const creator = await createUserWithToken();
    const outsider = await createUserWithToken();
    const room = await createRoom(creator.token, { isPrivate: true });

    const outsiderList = (await (await api("/chatroom", { token: outsider.token })).json()) as Array<{
      _id: string;
    }>;
    expect(outsiderList.some((r) => r._id === room.id)).toBe(false);

    const creatorList = (await (await api("/chatroom", { token: creator.token })).json()) as Array<{
      _id: string;
      myRole: string | null;
    }>;
    const mine = creatorList.find((r) => r._id === room.id);
    expect(mine).toBeTruthy();
    expect(mine?.myRole).toBe("owner");
  });

  // ── Private room lockout ────────────────────────────────────────────────────

  it("non-member REST reads on a private room are 403 not_member (messages, search, pinned)", async () => {
    const creator = await createUserWithToken();
    const outsider = await createUserWithToken();
    const room = await createRoom(creator.token, { isPrivate: true });

    const messages = await api(`/chatroom/${room.id}/messages`, { token: outsider.token });
    expect(messages.status).toBe(403);
    expect(((await messages.json()) as { code: string }).code).toBe("not_member");

    const search = await api(`/chatroom/${room.id}/messages/search?q=hello`, { token: outsider.token });
    expect(search.status).toBe(403);
    expect(((await search.json()) as { code: string }).code).toBe("not_member");

    const pinned = await api(`/chatroom/${room.id}/pinned`, { token: outsider.token });
    expect(pinned.status).toBe(403);
    expect(((await pinned.json()) as { code: string }).code).toBe("not_member");
  });

  it("non-member socket send into a private room is refused and nothing is persisted", async () => {
    const creator = await createUserWithToken();
    const outsider = await createUserWithToken();
    const room = await createRoom(creator.token, { isPrivate: true });

    const socket = await connectClient(server.baseUrl, outsider.token);
    const ack = await emitMessage(socket, {
      chatroomId: room.id,
      message: "let me in",
      clientMessageId: randomUUID(),
    });

    expect(ack.ok).toBe(false);
    expect(ack.error).toBe("forbidden");
    expect(await Message.countDocuments({ chatroom: room.id })).toBe(0);
    socket.disconnect();
  });

  it("non-member joinRoom on a private room is silently ignored — no broadcasts received", async () => {
    const creator = await createUserWithToken("Private Owner");
    const outsider = await createUserWithToken("Eavesdropper");
    const room = await createRoom(creator.token, { isPrivate: true });

    const creatorSocket = await connectClient(server.baseUrl, creator.token);
    const outsiderSocket = await connectClient(server.baseUrl, outsider.token);

    creatorSocket.emit("joinRoom", { chatroomId: room.id });
    outsiderSocket.emit("joinRoom", { chatroomId: room.id });
    await new Promise((r) => setTimeout(r, 200)); // let joins land

    let leaked = false;
    outsiderSocket.on("newMessage", () => {
      leaked = true;
    });

    const ack = await emitMessage(creatorSocket, {
      chatroomId: room.id,
      message: "members only",
      clientMessageId: randomUUID(),
    });
    expect(ack.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 300));
    expect(leaked).toBe(false);

    creatorSocket.disconnect();
    outsiderSocket.disconnect();
  });

  // ── Invite flow ─────────────────────────────────────────────────────────────

  it("owner invites a user, who can then read; re-invite 409s; plain members cannot invite", async () => {
    const owner = await createUserWithToken();
    const invitee = await createUserWithToken();
    const third = await createUserWithToken();
    const room = await createRoom(owner.token, { isPrivate: true });

    // Sanity: locked out before the invite
    expect((await api(`/chatroom/${room.id}/messages`, { token: invitee.token })).status).toBe(403);

    const invite = await api(`/chatroom/${room.id}/invite`, {
      method: "POST",
      token: owner.token,
      body: { userId: invitee.userId },
    });
    expect(invite.status).toBe(200);

    // Invitee can now read messages
    const read = await api(`/chatroom/${room.id}/messages`, { token: invitee.token });
    expect(read.status).toBe(200);

    // Re-invite is a conflict
    const again = await api(`/chatroom/${room.id}/invite`, {
      method: "POST",
      token: owner.token,
      body: { userId: invitee.userId },
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("already_member");

    // A plain member may not invite
    const memberInvite = await api(`/chatroom/${room.id}/invite`, {
      method: "POST",
      token: invitee.token,
      body: { userId: third.userId },
    });
    expect(memberInvite.status).toBe(403);
    expect(((await memberInvite.json()) as { code: string }).code).toBe("insufficient_role");
  });

  // ── Public room participation ───────────────────────────────────────────────

  it("any user can join a public room and appears in the members list", async () => {
    const creator = await createUserWithToken();
    const joiner = await createUserWithToken();
    const room = await createRoom(creator.token);

    const join = await api(`/chatroom/${room.id}/join`, { method: "POST", token: joiner.token });
    expect(join.status).toBe(200);

    const { members, myRole } = await getMembers(joiner.token, room.id);
    const entry = members.find((m) => memberUserId(m) === joiner.userId);
    expect(entry).toBeTruthy();
    expect(entry?.role).toBe("member");
    // Regression guard: getMembers must compute myRole BEFORE populate()
    // mutates members.user into User documents (a past bug made this null
    // for everyone, including the owner).
    expect(myRole).toBe("member");
  });

  it("sending a message in a public room records participation for a fresh user", async () => {
    const creator = await createUserWithToken();
    const sender = await createUserWithToken();
    const room = await createRoom(creator.token);

    const socket = await connectClient(server.baseUrl, sender.token);
    // Deliberately NO joinRoom first — sending alone must record
    // participation (the send path calls ensureMembership for non-members).
    const ack = await emitMessage(socket, {
      chatroomId: room.id,
      message: "first post",
      clientMessageId: randomUUID(),
    });
    expect(ack.ok).toBe(true);

    const { members } = await getMembers(sender.token, room.id);
    expect(members.some((m) => memberUserId(m) === sender.userId)).toBe(true);

    socket.disconnect();
  });

  // ── Roles ───────────────────────────────────────────────────────────────────

  it("owner promotes a member to admin, and the admin can then invite", async () => {
    const owner = await createUserWithToken();
    const member = await createUserWithToken();
    const newcomer = await createUserWithToken();
    const room = await createRoom(owner.token, { isPrivate: true });

    await api(`/chatroom/${room.id}/invite`, {
      method: "POST",
      token: owner.token,
      body: { userId: member.userId },
    });

    const promote = await api(`/chatroom/${room.id}/members/${member.userId}`, {
      method: "PATCH",
      token: owner.token,
      body: { role: "admin" },
    });
    expect(promote.status).toBe(200);

    const { members } = await getMembers(owner.token, room.id);
    expect(members.find((m) => memberUserId(m) === member.userId)?.role).toBe("admin");

    const adminInvite = await api(`/chatroom/${room.id}/invite`, {
      method: "POST",
      token: member.token,
      body: { userId: newcomer.userId },
    });
    expect(adminInvite.status).toBe(200);
  });

  it("promoting a member to owner transfers ownership — previous owner becomes admin", async () => {
    const owner = await createUserWithToken();
    const successor = await createUserWithToken();
    const room = await createRoom(owner.token, { isPrivate: true });

    await api(`/chatroom/${room.id}/invite`, {
      method: "POST",
      token: owner.token,
      body: { userId: successor.userId },
    });

    const transfer = await api(`/chatroom/${room.id}/members/${successor.userId}`, {
      method: "PATCH",
      token: owner.token,
      body: { role: "owner" },
    });
    expect(transfer.status).toBe(200);

    const { members } = await getMembers(owner.token, room.id);
    expect(members.find((m) => memberUserId(m) === successor.userId)?.role).toBe("owner");
    expect(members.find((m) => memberUserId(m) === owner.userId)?.role).toBe("admin");
  });

  it("owner cannot leave; a plain member leaves cleanly", async () => {
    const owner = await createUserWithToken();
    const member = await createUserWithToken();
    const room = await createRoom(owner.token, { isPrivate: true });

    await api(`/chatroom/${room.id}/invite`, {
      method: "POST",
      token: owner.token,
      body: { userId: member.userId },
    });

    const ownerLeave = await api(`/chatroom/${room.id}/leave`, { method: "POST", token: owner.token });
    expect(ownerLeave.status).toBe(400);
    expect(((await ownerLeave.json()) as { code: string }).code).toBe("owner_cannot_leave");

    const memberLeave = await api(`/chatroom/${room.id}/leave`, { method: "POST", token: member.token });
    expect(memberLeave.status).toBe(200);

    const { members } = await getMembers(owner.token, room.id);
    expect(members.some((m) => memberUserId(m) === member.userId)).toBe(false);
  });
});
