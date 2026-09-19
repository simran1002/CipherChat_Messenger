import { describe, expect, it } from "vitest";
import { openV2, sealV2, startInitiator, startResponder } from "./envelopeV2";
import { generateDek, openRecord, sealRecord, messageKey } from "./vault";
import { generateEd25519, generateX25519, sign, toBase64 } from "./primitives";
import type { StoredIdentity } from "./keyStore";
import type { PeerBundle } from "./session";

function identity(): StoredIdentity {
  const ed = generateEd25519();
  const x = generateX25519();
  const spk = generateX25519();
  return {
    edPriv: toBase64(ed.privateKey), edPub: toBase64(ed.publicKey),
    xPriv: toBase64(x.privateKey), xPub: toBase64(x.publicKey),
    spkId: 1, spkPriv: toBase64(spk.privateKey), spkPub: toBase64(spk.publicKey), createdAt: 0,
  };
}

function bundleOf(id: StoredIdentity): PeerBundle {
  const spkPub = Uint8Array.from(atob(id.spkPub), (c) => c.charCodeAt(0));
  const edPriv = Uint8Array.from(atob(id.edPriv), (c) => c.charCodeAt(0));
  return {
    identityEd25519: id.edPub,
    identityX25519: id.xPub,
    signedPreKey: { keyId: id.spkId, pubX25519: id.spkPub, sig: toBase64(sign(edPriv, spkPub)) },
  };
}

const CONV = "conv-42";

describe("envelope v2 (X3DH → Double Ratchet)", () => {
  it("establishes a session from the first envelope and converses both ways", () => {
    const alice = identity();
    const bob = identity();
    let a = startInitiator(CONV, "bob", alice, bundleOf(bob));

    const first = sealV2(a, "alice", "hello bob");
    a = first.next;
    expect(first.envelope).toMatchObject({ v: 2, ctr: 0, n: 0, pn: 0 });
    expect(first.envelope.init).toBeDefined();

    let b = startResponder(CONV, "alice", first.envelope.sessionId, bob, first.envelope.init!);
    const got = openV2(b, "alice", first.envelope);
    b = got.next;
    expect(got.text).toBe("hello bob");

    const reply = sealV2(b, "bob", "hello alice");
    b = reply.next;
    expect(reply.envelope.init).toBeUndefined();
    const back = openV2(a, "bob", reply.envelope);
    a = back.next;
    expect(back.text).toBe("hello alice");

    const third = sealV2(a, "alice", "init block no longer rides along");
    expect(third.envelope.init).toBeUndefined();          // peer has replied
    expect(third.envelope.ctr).toBe(1);                   // monotonic across the DH ratchet step…
    expect(third.envelope.n).toBe(0);                     // …while the chain counter restarted
  });

  it("keeps attaching the init block until the peer answers (first frame may be lost)", () => {
    const alice = identity();
    const bob = identity();
    let a = startInitiator(CONV, "bob", alice, bundleOf(bob));
    const lost = sealV2(a, "alice", "lost in transit");
    a = lost.next;
    const second = sealV2(a, "alice", "arrives first");
    expect(second.envelope.init).toBeDefined();

    let b = startResponder(CONV, "alice", second.envelope.sessionId, bob, second.envelope.init!);
    const r = openV2(b, "alice", second.envelope);
    b = r.next;
    expect(r.text).toBe("arrives first");
    expect(openV2(b, "alice", lost.envelope).text).toBe("lost in transit");   // skipped key still held
  });

  it("rejects a bundle whose prekey is not signed by the identity key", () => {
    const alice = identity();
    const bob = identity();
    const mallory = identity();
    const forged = { ...bundleOf(bob), signedPreKey: { ...bundleOf(bob).signedPreKey, pubX25519: mallory.spkPub } };
    expect(() => startInitiator(CONV, "bob", alice, forged)).toThrowError(/signature invalid/);
  });

  it("binds sender and counter: a frame re-attributed or renumbered fails", () => {
    const alice = identity();
    const bob = identity();
    const a = startInitiator(CONV, "bob", alice, bundleOf(bob));
    const { envelope } = sealV2(a, "alice", "bound");
    const b = startResponder(CONV, "alice", envelope.sessionId, bob, envelope.init!);
    expect(() => openV2(b, "mallory", envelope)).toThrow();
    expect(() => openV2(b, "alice", { ...envelope, ctr: 7 })).toThrow();
    expect(openV2(b, "alice", envelope).text).toBe("bound");
  });
});

describe("vault sealing (the data cryptographic shredding destroys)", () => {
  it("round-trips under the conversation key and hides the plaintext", async () => {
    const key = await generateDek();
    const label = `message:${CONV}|${messageKey("s1", "alice", 0)}`;
    const row = await sealRecord(key, label, "privileged and confidential");
    expect(new TextDecoder().decode(row.blob)).not.toContain("privileged");
    expect(await openRecord<string>(key, label, row)).toBe("privileged and confidential");
  });

  it("a row opened under another label, or another conversation's key, is rejected", async () => {
    const key = await generateDek();
    const row = await sealRecord(key, "message:conv-A|s1|alice|0", "secret");
    await expect(openRecord(key, "message:conv-B|s1|alice|0", row)).rejects.toThrow();
    await expect(openRecord(await generateDek(), "message:conv-A|s1|alice|0", row)).rejects.toThrow();
  });

  it("shredding in one line: without the key the sealed history cannot be opened by anyone", async () => {
    let key: CryptoKey | null = await generateDek();
    const rows = await Promise.all(["m1", "m2", "m3"].map((t, i) => sealRecord(key!, `message:${CONV}|s|a|${i}`, t)));
    key = null; // the DEK was non-extractable: there is no other copy to recover
    const stranger = await generateDek();
    for (const [i, row] of rows.entries()) {
      await expect(openRecord(stranger, `message:${CONV}|s|a|${i}`, row)).rejects.toThrow();
    }
  });
});
