import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import type { Socket as ClientSocket } from "socket.io-client";
import { startDb, stopDb } from "../helpers/db.js";
import {
  connectClient,
  createUserWithToken,
  startTestServer,
  type TestServer,
} from "../helpers/testServer.js";
import { DMMessage } from "../../src/models/DMMessage.js";

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

function makeBundle() {
  const edPriv = ed25519.utils.randomSecretKey();
  const edPub = ed25519.getPublicKey(edPriv);
  const xPriv = x25519.utils.randomSecretKey();
  const xPub = x25519.getPublicKey(xPriv);
  const spkPriv = x25519.utils.randomSecretKey();
  const spkPub = x25519.getPublicKey(spkPriv);
  const sig = ed25519.sign(spkPub, edPriv);
  return {
    identityEd25519: b64(edPub),
    identityX25519: b64(xPub),
    signedPreKey: { keyId: 1, pubX25519: b64(spkPub), sig: b64(sig) },
  };
}

function envelopeOf(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    v: 1,
    sessionId: randomUUID(),
    ctr: 0,
    ct: Buffer.from("ciphertext-bytes-here").toString("base64"),
    init: { ephPub: b64(x25519.getPublicKey(x25519.utils.randomSecretKey())), ik: b64(new Uint8Array(32)), spkId: 1 },
    ...overrides,
  };
}

async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("key directory + E2EE DM flow", () => {
  let server: TestServer;

  beforeAll(async () => {
    await startDb();
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
    await stopDb();
  });

  describe("PUT/GET /keys", () => {
    it("publishes a valid bundle and serves it to peers", async () => {
      const alice = await createUserWithToken("Keys Alice");
      const bob = await createUserWithToken("Keys Bob");
      const bundle = makeBundle();

      const put = await json(
        await fetch(`${server.baseUrl}/keys`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${alice.token}` },
          body: JSON.stringify(bundle),
        })
      );
      expect(put.status).toBe(200);
      expect(put.body.keyVersion).toBe(1);

      const get = await json(
        await fetch(`${server.baseUrl}/keys/${alice.userId}`, {
          headers: { Authorization: `Bearer ${bob.token}` },
        })
      );
      expect(get.status).toBe(200);
      const keys = get.body.keys as { identityEd25519: string; signedPreKey: { pubX25519: string } };
      expect(keys.identityEd25519).toBe(bundle.identityEd25519);
      expect(keys.signedPreKey.pubX25519).toBe(bundle.signedPreKey.pubX25519);
    });

    it("rejects a bundle whose prekey is not signed by the identity key", async () => {
      const user = await createUserWithToken("Keys Forger");
      const bundle = makeBundle();
      const other = makeBundle();
      bundle.signedPreKey.sig = other.signedPreKey.sig; // signature from a different identity

      const put = await json(
        await fetch(`${server.baseUrl}/keys`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
          body: JSON.stringify(bundle),
        })
      );
      expect(put.status).toBe(400);
      expect(put.body.code).toBe("bad_prekey_signature");
    });

    it("bumps keyVersion when the identity changes (reset detection)", async () => {
      const user = await createUserWithToken("Keys Resetter");
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` };

      const first = await json(
        await fetch(`${server.baseUrl}/keys`, { method: "PUT", headers, body: JSON.stringify(makeBundle()) })
      );
      expect(first.body.keyVersion).toBe(1);

      const second = await json(
        await fetch(`${server.baseUrl}/keys`, { method: "PUT", headers, body: JSON.stringify(makeBundle()) })
      );
      expect(second.body.keyVersion).toBe(2);
    });

    it("stores and returns the opaque backup blob; 404 when none", async () => {
      const user = await createUserWithToken("Keys Backup");
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` };

      const missing = await fetch(`${server.baseUrl}/keys/backup/blob`, { headers });
      expect(missing.status).toBe(404);

      const blob = Buffer.from("opaque-encrypted-backup").toString("base64");
      const put = await fetch(`${server.baseUrl}/keys/backup/blob`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ blob }),
      });
      expect(put.status).toBe(200);

      const got = await json(await fetch(`${server.baseUrl}/keys/backup/blob`, { headers }));
      expect(got.body.blob).toBe(blob);
    });
  });

  describe("directMessage with E2EE envelopes", () => {
    async function startConv(tokenA: string, userIdB: string): Promise<string> {
      const res = await json(
        await fetch(`${server.baseUrl}/dm/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({ targetUserId: userIdB }),
        })
      );
      return res.body._id as string;
    }

    function emitDm(socket: ClientSocket, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
      return new Promise((resolve) => socket.emit("directMessage", payload, resolve));
    }

    it("persists an envelope opaquely and never forwards plaintext anywhere", async () => {
      const alice = await createUserWithToken("E2EE Alice");
      const bob = await createUserWithToken("E2EE Bob");
      const convId = await startConv(alice.token, bob.userId);

      const aliceSocket = await connectClient(server.baseUrl, alice.token);
      const bobSocket = await connectClient(server.baseUrl, bob.token);
      bobSocket.emit("joinDM", { conversationId: convId });
      await new Promise((r) => setTimeout(r, 200));

      const gotMessage = new Promise<Record<string, unknown>>((resolve) =>
        bobSocket.once("newDirectMessage", resolve)
      );
      const gotNotification = new Promise<Record<string, unknown>>((resolve) =>
        bobSocket.once("dmNotification", resolve)
      );

      const envelope = envelopeOf();
      const ack = await emitDm(aliceSocket, {
        conversationId: convId,
        clientMessageId: randomUUID(),
        envelope,
      });
      expect(ack.ok).toBe(true);

      const wire = await gotMessage;
      expect(wire.type).toBe("e2ee/v1");
      expect(wire.message).toBeUndefined();
      expect((wire.envelope as { ct: string }).ct).toBe(envelope.ct);

      const notif = await gotNotification;
      expect(notif.message).toBe("🔒 Encrypted message");

      const row = await DMMessage.findOne({ conversationId: convId });
      expect(row?.type).toBe("e2ee/v1");
      expect(row?.body).toBe("");
      expect(row?.envelope?.ct).toBe(envelope.ct);

      aliceSocket.disconnect();
      bobSocket.disconnect();
    });

    it("rejects a replayed (sessionId, ctr) slot via the unique index", async () => {
      const alice = await createUserWithToken("E2EE Replay A");
      const bob = await createUserWithToken("E2EE Replay B");
      const convId = await startConv(alice.token, bob.userId);
      const socket = await connectClient(server.baseUrl, alice.token);

      const envelope = envelopeOf();
      const first = await emitDm(socket, { conversationId: convId, clientMessageId: randomUUID(), envelope });
      expect(first.ok).toBe(true);

      // Same session+ctr, DIFFERENT clientMessageId — a true replay, not a retry
      const replay = await emitDm(socket, { conversationId: convId, clientMessageId: randomUUID(), envelope });
      expect(replay.ok).toBe(false);
      expect(replay.error).toBe("replayed_counter");

      expect(await DMMessage.countDocuments({ conversationId: convId })).toBe(1);
      socket.disconnect();
    });

    it("is idempotent for retries (same clientMessageId)", async () => {
      const alice = await createUserWithToken("E2EE Retry A");
      const bob = await createUserWithToken("E2EE Retry B");
      const convId = await startConv(alice.token, bob.userId);
      const socket = await connectClient(server.baseUrl, alice.token);

      const clientMessageId = randomUUID();
      const envelope = envelopeOf();
      const first = await emitDm(socket, { conversationId: convId, clientMessageId, envelope });
      const retry = await emitDm(socket, { conversationId: convId, clientMessageId, envelope });

      expect(first.ok).toBe(true);
      expect(retry.ok).toBe(true);
      expect(retry.duplicate).toBe(true);
      expect(retry.messageId).toBe(first.messageId);
      expect(await DMMessage.countDocuments({ conversationId: convId })).toBe(1);
      socket.disconnect();
    });

    it("rejects malformed envelopes and mixed plaintext+envelope sends", async () => {
      const alice = await createUserWithToken("E2EE Malformed A");
      const bob = await createUserWithToken("E2EE Malformed B");
      const convId = await startConv(alice.token, bob.userId);
      const socket = await connectClient(server.baseUrl, alice.token);

      const cases: Array<Record<string, unknown>> = [
        { conversationId: convId, envelope: envelopeOf({ v: 2 }) },
        { conversationId: convId, envelope: envelopeOf({ ctr: -1 }) },
        { conversationId: convId, envelope: envelopeOf({ ct: "" }) },
        { conversationId: convId, envelope: envelopeOf({ ct: "x".repeat(20000) }) },
        { conversationId: convId, message: "plain", envelope: envelopeOf() },
        { conversationId: convId },
      ];
      for (const payload of cases) {
        const ack = await emitDm(socket, { clientMessageId: randomUUID(), ...payload });
        expect(ack.ok, JSON.stringify(payload).slice(0, 80)).toBe(false);
        expect(ack.error).toBe("invalid_message");
      }
      expect(await DMMessage.countDocuments({ conversationId: convId })).toBe(0);
      socket.disconnect();
    });
  });
});
