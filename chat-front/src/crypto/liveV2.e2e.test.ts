/**
 * LIVE end-to-end check of envelope v2 against a running backend. Skipped unless LIVE_BASE_URL is set:
 *
 *   LIVE_BASE_URL=http://localhost:8080 npx vitest run src/crypto/liveV2.e2e.test.ts
 *
 * Two real accounts publish identities, run X3DH, exchange Double Ratchet envelopes through the
 * server's REST API, and read them back from the server's history — proving the server accepts,
 * stores and returns v2 envelopes opaquely, and that its replay index still rejects a reused counter.
 */
import { describe, expect, it } from "vitest";
import { openV2, sealV2, startInitiator, startResponder, type WireEnvelopeV2 } from "./envelopeV2";
import { fromBase64, generateEd25519, generateX25519, sign, toBase64 } from "./primitives";
import type { StoredIdentity } from "./keyStore";
import type { PeerBundle } from "./session";

const BASE = process.env.LIVE_BASE_URL;

interface Account {
  id: string;
  token: string;
  identity: StoredIdentity;
}

async function call(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
  });
}

function newIdentity(): StoredIdentity {
  const ed = generateEd25519();
  const x = generateX25519();
  const spk = generateX25519();
  return {
    edPriv: toBase64(ed.privateKey), edPub: toBase64(ed.publicKey),
    xPriv: toBase64(x.privateKey), xPub: toBase64(x.publicKey),
    spkId: 1, spkPriv: toBase64(spk.privateKey), spkPub: toBase64(spk.publicKey), createdAt: Date.now(),
  };
}

async function account(name: string): Promise<Account> {
  const res = await call("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email: `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@live.test`, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { token: string; user: { id: string } };
  const identity = newIdentity();
  const sig = sign(fromBase64(identity.edPriv), fromBase64(identity.spkPub));
  const put = await call("/api/v1/keys", {
    method: "PUT",
    token: body.token,
    body: JSON.stringify({
      identityEd25519: identity.edPub,
      identityX25519: identity.xPub,
      signedPreKey: { keyId: identity.spkId, pubX25519: identity.spkPub, sig: toBase64(sig) },
    }),
  });
  expect(put.ok).toBe(true);
  return { id: body.user.id, token: body.token, identity };
}

async function send(who: Account, conversationId: string, envelope: WireEnvelopeV2): Promise<Response> {
  return call(`/api/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    token: who.token,
    body: JSON.stringify({ clientMessageId: crypto.randomUUID(), envelope }),
  });
}

describe.skipIf(!BASE)("live: Double Ratchet envelopes through the real server", () => {
  it("X3DH from the server's key directory, a ratcheted exchange, history read-back, replay rejected", async () => {
    const alice = await account("Alice");
    const bob = await account("Bob");

    const conv = await call("/api/v1/conversations", { method: "POST", token: alice.token, body: JSON.stringify({ targetUserId: bob.id }) });
    expect(conv.status).toBeLessThan(300);
    const convBody = (await conv.json()) as Record<string, unknown>;
    const conversationId = String(convBody.id ?? convBody._id ?? (convBody.conversation as Record<string, unknown> | undefined)?.id);
    expect(conversationId).toMatch(/[0-9a-f-]{36}/);

    // Alice fetches Bob's bundle from the SERVER (which verified the prekey signature on publish).
    const bundleRes = await call(`/api/v1/keys/${bob.id}`, { token: alice.token });
    const bundle = ((await bundleRes.json()) as { keys: PeerBundle }).keys;

    let a = startInitiator(conversationId, bob.id, alice.identity, bundle);
    const m1 = sealV2(a, alice.id, "v2 hello over the wire");
    a = m1.next;
    expect((await send(alice, conversationId, m1.envelope)).status).toBe(201);

    // The server's replay backstop still works without understanding the ratchet: same (session, ctr) → 409.
    const replay = await send(alice, conversationId, m1.envelope);
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as { code: string }).code).toBe("replayed_counter");

    // Bob reads the envelope back from the server's history and opens it.
    const history = await call(`/api/v1/conversations/${conversationId}/messages`, { token: bob.token });
    const rows = ((await history.json()) as { messages: { envelope: WireEnvelopeV2; userId: string }[] }).messages;
    const stored = rows.find((r) => r.envelope?.v === 2)!;
    expect(stored.envelope).toMatchObject({ v: 2, ctr: 0, dh: m1.envelope.dh });
    let b = startResponder(conversationId, alice.id, stored.envelope.sessionId, bob.identity, stored.envelope.init!);
    const got = openV2(b, alice.id, stored.envelope);
    b = got.next;
    expect(got.text).toBe("v2 hello over the wire");

    // Reply: a DH ratchet step on the wire, accepted by the server, opened by Alice.
    const m2 = sealV2(b, bob.id, "v2 reply with a fresh ratchet key");
    b = m2.next;
    expect((await send(bob, conversationId, m2.envelope)).status).toBe(201);
    expect(openV2(a, bob.id, m2.envelope).text).toBe("v2 reply with a fresh ratchet key");

    // A malformed ratchet header is refused at the door.
    const bad = await send(bob, conversationId, { ...sealV2(b, bob.id, "x").envelope, dh: "AAAA" });
    expect(bad.status).toBe(400);
  }, 60_000);
});
