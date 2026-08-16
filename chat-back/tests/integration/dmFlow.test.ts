import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { startDb, stopDb } from "../helpers/db.js";
import {
  connectClient,
  createUserWithToken,
  startTestServer,
  type TestServer,
} from "../helpers/testServer.js";
import { DirectMessage } from "../../src/models/DirectMessage.js";
import { DMMessage } from "../../src/models/DMMessage.js";

interface DmStartResponse {
  _id: string;
  participant?: { _id: string; name?: string };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("direct message flow (REST + socket integration)", () => {
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

  async function startConversation(token: string, targetUserId: string): Promise<DmStartResponse> {
    const res = await fetch(`${server.baseUrl}/dm/start`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ targetUserId }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as DmStartResponse;
  }

  async function connect(token: string): Promise<ClientSocket> {
    const socket = await connectClient(server.baseUrl, token);
    openSockets.push(socket);
    return socket;
  }

  it("POST /dm/start creates a conversation and is idempotent", async () => {
    const alice = await createUserWithToken("DM Alice");
    const bob = await createUserWithToken("DM Bob");

    const first = await startConversation(alice.token, bob.userId);
    expect(first._id).toBeTruthy();
    expect(first.participant?._id).toBe(bob.userId);

    const second = await startConversation(alice.token, bob.userId);
    expect(second._id).toBe(first._id); // same conversation, not a new one

    const count = await DirectMessage.countDocuments({
      participants: { $all: [alice.userId, bob.userId], $size: 2 },
    });
    expect(count).toBe(1);
  });

  it("delivers directMessage to the other participant via joinDM", async () => {
    const alice = await createUserWithToken("DM Alice 2");
    const bob = await createUserWithToken("DM Bob 2");
    const conv = await startConversation(alice.token, bob.userId);

    const aliceSocket = await connect(alice.token);
    const bobSocket = await connect(bob.token);

    aliceSocket.emit("joinDM", { conversationId: conv._id });
    bobSocket.emit("joinDM", { conversationId: conv._id });
    await wait(200); // joinDM does an async participant check

    const received = new Promise<{ conversationId: string; message: string; userId: string }>(
      (resolve) => bobSocket.once("newDirectMessage", resolve)
    );

    aliceSocket.emit("directMessage", { conversationId: conv._id, message: "psst, bob" });

    const msg = await received;
    expect(msg.conversationId).toBe(conv._id);
    expect(msg.message).toBe("psst, bob");
    expect(msg.userId).toBe(alice.userId);

    const saved = await DMMessage.find({ conversationId: conv._id });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.body).toBe("psst, bob");
    expect(saved[0]?.type).toBe("plaintext-legacy");
  });

  it("a non-participant emitting directMessage writes nothing", async () => {
    const alice = await createUserWithToken("DM Alice 3");
    const bob = await createUserWithToken("DM Bob 3");
    const mallory = await createUserWithToken("DM Mallory 3");
    const conv = await startConversation(alice.token, bob.userId);

    const mallorySocket = await connect(mallory.token);
    mallorySocket.emit("directMessage", { conversationId: conv._id, message: "let me in" });
    await wait(300); // give the handler time to (not) write

    const saved = await DMMessage.find({ conversationId: conv._id });
    expect(saved).toHaveLength(0);
  });

  it("a non-participant who joinDMs receives nothing when participants exchange messages", async () => {
    const alice = await createUserWithToken("DM Alice 4");
    const bob = await createUserWithToken("DM Bob 4");
    const eve = await createUserWithToken("DM Eve 4");
    const conv = await startConversation(alice.token, bob.userId);

    const aliceSocket = await connect(alice.token);
    const bobSocket = await connect(bob.token);
    const eveSocket = await connect(eve.token);

    aliceSocket.emit("joinDM", { conversationId: conv._id });
    bobSocket.emit("joinDM", { conversationId: conv._id });
    eveSocket.emit("joinDM", { conversationId: conv._id }); // silently denied
    await wait(200);

    let eveHeard = false;
    eveSocket.on("newDirectMessage", () => {
      eveHeard = true;
    });

    const bobReceived = new Promise<{ message: string }>((resolve) =>
      bobSocket.once("newDirectMessage", resolve)
    );

    aliceSocket.emit("directMessage", { conversationId: conv._id, message: "for bob only" });

    const msg = await bobReceived; // delivery to the legit participant happened
    expect(msg.message).toBe("for bob only");

    await wait(200); // anything bound for eve would have arrived by now
    expect(eveHeard).toBe(false);
  });
});
