import { describe, expect, it } from "vitest";
import { fromBase64, sign, toBase64 } from "./primitives";
import { generateIdentity } from "./identity";
import {
  acceptSession,
  initiateSession,
  messageKeyAt,
  needsRotation,
  receiveChainRoot,
  ROTATE_AFTER_MESSAGES,
  sendChainRoot,
  verifyBundle,
  type PeerBundle,
} from "./session";
import { open, openOwn, seal } from "./envelope";
import type { StoredSession } from "./keyStore";

function bundleOf(identity: ReturnType<typeof generateIdentity>): PeerBundle {
  return {
    identityEd25519: identity.edPub,
    identityX25519: identity.xPub,
    signedPreKey: {
      keyId: identity.spkId,
      pubX25519: identity.spkPub,
      sig: toBase64(sign(fromBase64(identity.edPriv), fromBase64(identity.spkPub))),
    },
  };
}

const CONV = "conv-1";

function establishPair() {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const { session: aliceSession, init } = initiateSession(CONV, "bob", alice, bundleOf(bob));
  const bobSession = acceptSession(CONV, "alice", aliceSession.sessionId, bob, init);
  return { alice, bob, aliceSession, bobSession, init };
}

describe("X3DH-lite session establishment", () => {
  it("initiator and responder derive identical chain roots", () => {
    const { aliceSession, bobSession } = establishPair();
    expect(aliceSession.ckInit).toBe(bobSession.ckInit);
    expect(aliceSession.ckResp).toBe(bobSession.ckResp);
    expect(aliceSession.role).toBe("init");
    expect(bobSession.role).toBe("resp");
  });

  it("rejects a bundle with a forged prekey signature", () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const mallory = generateIdentity();
    const forged = bundleOf(bob);
    // Mallory swaps in her prekey but can't sign with Bob's identity key
    forged.signedPreKey.pubX25519 = mallory.spkPub;
    expect(verifyBundle(forged)).toBe(false);
    expect(() => initiateSession(CONV, "bob", alice, forged)).toThrow(/signature invalid/i);
  });

  it("responder rejects an unknown prekey id", () => {
    const { init } = establishPair();
    const otherBob = generateIdentity();
    otherBob.spkId = 99;
    expect(() => acceptSession(CONV, "alice", "sid", otherBob, init)).toThrow(/prekey id/i);
  });

  it("send/receive chains are opposite per role", () => {
    const { aliceSession, bobSession } = establishPair();
    expect(toBase64(sendChainRoot(aliceSession))).toBe(toBase64(receiveChainRoot(bobSession)));
    expect(toBase64(sendChainRoot(bobSession))).toBe(toBase64(receiveChainRoot(aliceSession)));
  });
});

describe("counter-addressed chain ratchet", () => {
  const root = fromBase64("qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo="); // fixed 32B

  it("derives deterministic, distinct keys per counter", () => {
    const k0 = messageKeyAt(root, 0);
    const k0again = messageKeyAt(root, 0);
    const k1 = messageKeyAt(root, 1);
    expect(toBase64(k0.key)).toBe(toBase64(k0again.key));
    expect(toBase64(k0.key)).not.toBe(toBase64(k1.key));
    expect(toBase64(k0.iv)).not.toBe(toBase64(k1.iv));
    expect(k0.key.length).toBe(32);
    expect(k0.iv.length).toBe(12);
  });

  it("golden fixture: key derivation is pinned", () => {
    // Any refactor that changes these bytes breaks decryption of stored
    // history — this test must never be "fixed" by updating the constants
    // without a protocol version bump.
    const k = messageKeyAt(root, 3);
    expect(toBase64(k.key)).toBe("O6lP8uvU8eMeXAM7uOEmuVXsNLGaPmrTrYZabj41CNQ=");
    expect(toBase64(k.iv)).toBe("V3jlcLOEcqOi+15G");
  });
});

describe("seal/open envelope", () => {
  it("round-trips text both directions, including emoji + RTL", () => {
    const { aliceSession, bobSession } = establishPair();
    const texts = ["hello", "🔥🎉 emoji", "مرحبا بالعالم", "x".repeat(2000), ""];

    texts.forEach((text, i) => {
      const env = seal(aliceSession, CONV, "alice", i, text);
      expect(open(bobSession, CONV, "alice", env)).toBe(text);
    });

    const back = seal(bobSession, CONV, "bob", 0, "reply");
    expect(open(aliceSession, CONV, "bob", back)).toBe("reply");
  });

  it("out-of-order decryption works (counter-addressed)", () => {
    const { aliceSession, bobSession } = establishPair();
    const e5 = seal(aliceSession, CONV, "alice", 5, "fifth");
    const e2 = seal(aliceSession, CONV, "alice", 2, "second");
    expect(open(bobSession, CONV, "alice", e5)).toBe("fifth");
    expect(open(bobSession, CONV, "alice", e2)).toBe("second");
  });

  it("sender can decrypt own history via openOwn", () => {
    const { aliceSession } = establishPair();
    const env = seal(aliceSession, CONV, "alice", 7, "my own message");
    expect(openOwn(aliceSession, CONV, "alice", env)).toBe("my own message");
  });

  it("padding hides exact length in 256-byte buckets", () => {
    const { aliceSession } = establishPair();
    const short = seal(aliceSession, CONV, "alice", 0, "a");
    const alsoShort = seal(aliceSession, CONV, "alice", 1, "a".repeat(200));
    expect(fromBase64(short.ct).length).toBe(fromBase64(alsoShort.ct).length);
  });

  it("rejects tampering with ct and every AAD field", () => {
    const { aliceSession, bobSession } = establishPair();
    const env = seal(aliceSession, CONV, "alice", 0, "attack at dawn");

    const flipped = fromBase64(env.ct);
    flipped[10]! ^= 0x01;
    expect(() => open(bobSession, CONV, "alice", { ...env, ct: toBase64(flipped) })).toThrow();

    // moved to a different conversation
    expect(() => open(bobSession, "other-conv", "alice", env)).toThrow();
    // attributed to a different sender
    expect(() => open(bobSession, CONV, "mallory", env)).toThrow();
    // counter slot shifted (replay into a different slot)
    expect(() => open(bobSession, CONV, "alice", { ...env, ctr: 1 })).toThrow();
  });

  it("cross-session envelopes do not decrypt", () => {
    const pair1 = establishPair();
    const pair2 = establishPair();
    const env = seal(pair1.aliceSession, CONV, "alice", 0, "secret");
    const alien: StoredSession = { ...pair2.bobSession, sessionId: env.sessionId };
    expect(() => open(alien, CONV, "alice", env)).toThrow();
  });
});

describe("rotation policy", () => {
  it("flags rotation at the message cap and by age", () => {
    const { aliceSession } = establishPair();
    expect(needsRotation(aliceSession)).toBe(false);
    expect(needsRotation({ ...aliceSession, sendCtr: ROTATE_AFTER_MESSAGES })).toBe(true);
    expect(
      needsRotation({ ...aliceSession, createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000 })
    ).toBe(true);
  });

  it("old sessions still decrypt after a new session starts", () => {
    const { alice, bob, aliceSession, bobSession } = establishPair();
    const oldEnv = seal(aliceSession, CONV, "alice", 0, "from the old session");

    const { session: newAliceSession, init } = initiateSession(CONV, "bob", alice, bundleOf(bob));
    const newBobSession = acceptSession(CONV, "alice", newAliceSession.sessionId, bob, init);
    const newEnv = seal(newAliceSession, CONV, "alice", 0, "from the new session");

    expect(open(bobSession, CONV, "alice", oldEnv)).toBe("from the old session");
    expect(open(newBobSession, CONV, "alice", newEnv)).toBe("from the new session");
    expect(newAliceSession.sessionId).not.toBe(aliceSession.sessionId);
  });
});
