/**
 * Golden transcript — a deterministic, end-to-end protocol vector for the
 * X3DH-lite + counter-addressed chain ratchet + envelope layer.
 *
 * `fixtures/golden-transcript.json` pins: fixed identity / signed-prekey /
 * ephemeral keys for Alice and Bob (hex), the X3DH-lite init block, the two
 * chain roots, and six sealed envelopes alternating directions (ctr 0..2 on
 * BOTH chains). The regular tests re-derive both sessions from those keys and
 * assert that
 *   (a) every stored envelope decrypts to its plaintext (peer `open` and the
 *       sender's own `openOwn`), and
 *   (b) re-sealing the same plaintexts reproduces byte-identical envelopes.
 *
 * Any refactor that changes these bytes breaks decryption of stored history
 * and interop with a second implementation — this file must never be "fixed"
 * by regenerating the fixture without a protocol version bump.
 *
 * Determinism notes — the two random inputs in `initiateSession` are injected
 * through the seams the code already exposes (documented here, nothing in
 * src/ is special-cased for tests):
 *   - the ephemeral X25519 key comes from `primitives.generateX25519()`; the
 *     module is partially mocked so that ONE call returns the fixture key;
 *   - `sessionId` comes from `crypto.randomUUID()`; it is part of the AAD, so
 *     it is spied to return the fixture id. Everything else (HKDF, HMAC chain,
 *     derived IV, padding, AES-GCM) is already deterministic.
 *
 * Regenerate (only with a protocol version bump):
 *   REGEN_FIXTURE=1 npx vitest run src/crypto/goldenTranscript.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { fromBase64, generateX25519, sign, toBase64, verify } from "./primitives";
import { acceptSession, initiateSession, type PeerBundle } from "./session";
import { open, openOwn, seal, type WireEnvelope } from "./envelope";
import type { StoredIdentity, StoredSession } from "./keyStore";

vi.mock("./primitives", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./primitives")>();
  // Real implementation by default; a test may `mockReturnValueOnce` to inject
  // a fixed ephemeral key into initiateSession().
  return { ...actual, generateX25519: vi.fn(actual.generateX25519) };
});

const actualPrimitives = await vi.importActual<typeof import("./primitives")>("./primitives");

// ── Fixed key material (hex) ────────────────────────────────────────────────
// Private scalars are RFC test vectors where one exists (recognisable, and
// obviously not real user keys); public keys are derived, never hand-typed.

const ALICE_ID = "alice";
const BOB_ID = "bob";
const CONVERSATION_ID = "conv-golden";
const SESSION_ID = "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const CREATED_AT = 1_700_000_000_000;

const PRIV = {
  alice: {
    ed: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", // RFC 8032 §7.1 TEST 1 seed
    x: "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", // RFC 7748 §6.1 Alice
    spk: "a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4", // RFC 7748 §5.2 scalar #1
    eph: "4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d", // RFC 7748 §5.2 scalar #2
  },
  bob: {
    ed: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb", // RFC 8032 §7.1 TEST 2 seed
    x: "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb", // RFC 7748 §6.1 Bob
    spk: "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
  },
} as const;

const PLAINTEXTS: Array<{ dir: "alice->bob" | "bob->alice"; plaintext: string }> = [
  { dir: "alice->bob", plaintext: "Hello Bob — this is the golden transcript. Message 1/6." },
  { dir: "bob->alice", plaintext: "Hi Alice 👋 (2/6)" },
  { dir: "alice->bob", plaintext: "مرحبا بالعالم — RTL text, message 3/6" },
  { dir: "bob->alice", plaintext: "" }, // empty body still pads to a full bucket
  { dir: "alice->bob", plaintext: `5/6 crosses the 256-byte pad bucket: ${"x".repeat(300)}` },
  { dir: "bob->alice", plaintext: "Last one — 6/6 ✅" },
];

// ── Fixture shape ───────────────────────────────────────────────────────────

interface FixtureKeys {
  edPriv: string; // hex
  edPub: string;
  xPriv: string;
  xPub: string;
  spkId: number;
  spkPriv: string;
  spkPub: string;
}

interface FixtureMessage {
  dir: "alice->bob" | "bob->alice";
  ctr: number;
  plaintext: string;
  envelope: WireEnvelope;
}

interface Fixture {
  version: 1;
  regenerate: string;
  conversationId: string;
  aliceId: string;
  bobId: string;
  keys: { alice: FixtureKeys; bob: FixtureKeys; aliceEphemeral: { priv: string; pub: string } };
  bobBundleSig: string; // b64 Ed25519(bob.edPriv, bob.spkPub)
  init: { sessionId: string; ephPub: string; ik: string; spkId: number };
  chains: { ckInit: string; ckResp: string }; // b64
  messages: FixtureMessage[];
}

// vite-node serves test modules from a non-`file:` URL, so `import.meta.url`
// can't be turned into a path; vitest injects CJS-style `__dirname` instead.
const HERE = typeof __dirname === "string" ? __dirname : resolve(process.cwd(), "src/crypto");
const FIXTURE_PATH = resolve(HERE, "fixtures", "golden-transcript.json");
const REGEN = process.env.REGEN_FIXTURE === "1";

// ── Helpers ─────────────────────────────────────────────────────────────────

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

const hexToB64 = (h: string) => toBase64(hex(h));

function keysFromPriv(p: { ed: string; x: string; spk: string }): FixtureKeys {
  return {
    edPriv: p.ed,
    edPub: toHex(ed25519.getPublicKey(hex(p.ed))),
    xPriv: p.x,
    xPub: toHex(x25519.getPublicKey(hex(p.x))),
    spkId: 1,
    spkPriv: p.spk,
    spkPub: toHex(x25519.getPublicKey(hex(p.spk))),
  };
}

function identityFrom(k: FixtureKeys): StoredIdentity {
  return {
    edPriv: hexToB64(k.edPriv),
    edPub: hexToB64(k.edPub),
    xPriv: hexToB64(k.xPriv),
    xPub: hexToB64(k.xPub),
    spkId: k.spkId,
    spkPriv: hexToB64(k.spkPriv),
    spkPub: hexToB64(k.spkPub),
    createdAt: CREATED_AT,
  };
}

function bundleOf(identity: StoredIdentity): PeerBundle {
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

/**
 * Run the real initiator + responder code with the fixture's ephemeral key and
 * session id injected. Returns both sessions and the init block.
 */
function establish(keys: Fixture["keys"], sessionId: string) {
  const alice = identityFrom(keys.alice);
  const bob = identityFrom(keys.bob);

  vi.mocked(generateX25519).mockReturnValueOnce({
    privateKey: hex(keys.aliceEphemeral.priv),
    publicKey: hex(keys.aliceEphemeral.pub),
  });
  const uuidSpy = vi
    .spyOn(crypto, "randomUUID")
    .mockReturnValue(sessionId as `${string}-${string}-${string}-${string}-${string}`);
  let aliceSession: StoredSession;
  let init: ReturnType<typeof initiateSession>["init"];
  try {
    ({ session: aliceSession, init } = initiateSession(CONVERSATION_ID, BOB_ID, alice, bundleOf(bob)));
  } finally {
    uuidSpy.mockRestore();
  }
  const bobSession = acceptSession(CONVERSATION_ID, ALICE_ID, aliceSession.sessionId, bob, init);
  return { alice, bob, aliceSession, bobSession, init };
}

function sealerFor(dir: FixtureMessage["dir"], s: { aliceSession: StoredSession; bobSession: StoredSession }) {
  return dir === "alice->bob"
    ? { sender: s.aliceSession, senderId: ALICE_ID, receiver: s.bobSession }
    : { sender: s.bobSession, senderId: BOB_ID, receiver: s.aliceSession };
}

// ── Generator (REGEN_FIXTURE=1) ─────────────────────────────────────────────

describe.runIf(REGEN)("golden transcript — generator", () => {
  it("writes fixtures/golden-transcript.json", () => {
    const keys: Fixture["keys"] = {
      alice: keysFromPriv(PRIV.alice),
      bob: keysFromPriv(PRIV.bob),
      aliceEphemeral: { priv: PRIV.alice.eph, pub: toHex(x25519.getPublicKey(hex(PRIV.alice.eph))) },
    };
    const { bob, aliceSession, bobSession, init } = establish(keys, SESSION_ID);
    expect(aliceSession.ckInit).toBe(bobSession.ckInit);
    expect(aliceSession.ckResp).toBe(bobSession.ckResp);

    const ctr = { "alice->bob": 0, "bob->alice": 0 };
    const messages: FixtureMessage[] = PLAINTEXTS.map(({ dir, plaintext }) => {
      const { sender, senderId } = sealerFor(dir, { aliceSession, bobSession });
      const n = ctr[dir]++;
      const envelope = seal(sender, CONVERSATION_ID, senderId, n, plaintext, dir === "alice->bob" ? init : undefined);
      return { dir, ctr: n, plaintext, envelope };
    });

    const fixture: Fixture = {
      version: 1,
      regenerate: "REGEN_FIXTURE=1 npx vitest run src/crypto/goldenTranscript.test.ts",
      conversationId: CONVERSATION_ID,
      aliceId: ALICE_ID,
      bobId: BOB_ID,
      keys,
      bobBundleSig: bundleOf(bob).signedPreKey.sig,
      init: { sessionId: aliceSession.sessionId, ...init },
      chains: { ckInit: aliceSession.ckInit, ckResp: aliceSession.ckResp },
      messages,
    };

    mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n");
    expect(existsSync(FIXTURE_PATH)).toBe(true);
  });
});

// ── Regression / cross-implementation vector ────────────────────────────────

describe.skipIf(!REGEN && !existsSync(FIXTURE_PATH))("golden transcript — fixture vector", () => {
  let fixture: Fixture;

  beforeAll(() => {
    fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
  });

  afterEach(() => {
    // Drop call history and any unconsumed injected key, then restore the
    // real implementation (vitest 2's mockReset leaves the fn returning undefined).
    vi.mocked(generateX25519).mockReset();
    vi.mocked(generateX25519).mockImplementation(actualPrimitives.generateX25519);
  });

  it("has the expected shape: 6 messages alternating directions with ctr > 0 on both chains", () => {
    expect(fixture.version).toBe(1);
    expect(fixture.conversationId).toBe(CONVERSATION_ID);
    expect(fixture.messages).toHaveLength(6);
    expect(fixture.messages.map((m) => m.dir)).toEqual(PLAINTEXTS.map((p) => p.dir));
    expect(fixture.messages.map((m) => m.plaintext)).toEqual(PLAINTEXTS.map((p) => p.plaintext));
    expect(fixture.messages.filter((m) => m.dir === "alice->bob").map((m) => m.ctr)).toEqual([0, 1, 2]);
    expect(fixture.messages.filter((m) => m.dir === "bob->alice").map((m) => m.ctr)).toEqual([0, 1, 2]);
    // init rides only on the initiator's ctr-0 envelope
    expect(fixture.messages.map((m) => Boolean(m.envelope.init))).toEqual([true, false, false, false, false, false]);
    for (const m of fixture.messages) {
      expect(m.envelope.v).toBe(1);
      expect(m.envelope.sessionId).toBe(fixture.init.sessionId);
    }
  });

  it("key material is self-consistent: every public key derives from its stored private key", () => {
    for (const who of ["alice", "bob"] as const) {
      const k = fixture.keys[who];
      expect(k.edPriv).toBe(PRIV[who].ed);
      expect(k.xPriv).toBe(PRIV[who].x);
      expect(k.spkPriv).toBe(PRIV[who].spk);
      expect(toHex(ed25519.getPublicKey(hex(k.edPriv)))).toBe(k.edPub);
      expect(toHex(x25519.getPublicKey(hex(k.xPriv)))).toBe(k.xPub);
      expect(toHex(x25519.getPublicKey(hex(k.spkPriv)))).toBe(k.spkPub);
    }
    expect(fixture.keys.aliceEphemeral.priv).toBe(PRIV.alice.eph);
    expect(toHex(x25519.getPublicKey(hex(fixture.keys.aliceEphemeral.priv)))).toBe(fixture.keys.aliceEphemeral.pub);

    // Bob's signed-prekey signature is deterministic (Ed25519) and verifies
    const bob = identityFrom(fixture.keys.bob);
    expect(bundleOf(bob).signedPreKey.sig).toBe(fixture.bobBundleSig);
    expect(verify(fromBase64(bob.edPub), fromBase64(fixture.bobBundleSig), fromBase64(bob.spkPub))).toBe(true);
  });

  it("re-derives identical sessions on both sides from the fixture keys (init block + chain roots pinned)", () => {
    const { aliceSession, bobSession, init } = establish(fixture.keys, fixture.init.sessionId);

    expect(vi.mocked(generateX25519)).toHaveBeenCalledTimes(1); // the injected ephemeral was consumed
    expect({ sessionId: aliceSession.sessionId, ...init }).toEqual(fixture.init);
    expect(init.ephPub).toBe(hexToB64(fixture.keys.aliceEphemeral.pub));
    expect(init.ik).toBe(hexToB64(fixture.keys.alice.xPub));

    expect(aliceSession.role).toBe("init");
    expect(bobSession.role).toBe("resp");
    expect({ ckInit: aliceSession.ckInit, ckResp: aliceSession.ckResp }).toEqual(fixture.chains);
    expect({ ckInit: bobSession.ckInit, ckResp: bobSession.ckResp }).toEqual(fixture.chains);
  });

  it("(a) every stored envelope decrypts to its plaintext — peer open() and sender openOwn()", () => {
    const sessions = establish(fixture.keys, fixture.init.sessionId);

    for (const m of fixture.messages) {
      const { sender, senderId, receiver } = sealerFor(m.dir, sessions);
      expect(open(receiver, fixture.conversationId, senderId, m.envelope), `${m.dir} ctr=${m.ctr}`).toBe(m.plaintext);
      expect(openOwn(sender, fixture.conversationId, senderId, m.envelope), `${m.dir} ctr=${m.ctr} (own)`).toBe(
        m.plaintext
      );
    }
  });

  it("(b) re-sealing the same plaintexts reproduces byte-identical envelopes", () => {
    const sessions = establish(fixture.keys, fixture.init.sessionId);

    for (const m of fixture.messages) {
      const { sender, senderId } = sealerFor(m.dir, sessions);
      const resealed = seal(
        sender,
        fixture.conversationId,
        senderId,
        m.ctr,
        m.plaintext,
        m.dir === "alice->bob" ? sessions.init : undefined
      );
      expect(resealed, `${m.dir} ctr=${m.ctr}`).toEqual(m.envelope);
      // Byte identity of the serialized wire form, not just structural equality
      expect(JSON.stringify(resealed)).toBe(JSON.stringify(m.envelope));
      expect(toHex(fromBase64(resealed.ct))).toBe(toHex(fromBase64(m.envelope.ct)));
    }
  });

  it("padding is pinned: 256-byte buckets (+16B tag) and the 300-char message spills into the second bucket", () => {
    const sizes = fixture.messages.map((m) => fromBase64(m.envelope.ct).length);
    expect(sizes).toEqual([256 + 16, 256 + 16, 256 + 16, 256 + 16, 512 + 16, 256 + 16]);
  });

  it("responder-only derivation (no injected randomness) decrypts every alice->bob envelope", () => {
    // acceptSession is fully deterministic given the init block — a second
    // implementation needs only the fixture to validate the initiator's output.
    const bob = identityFrom(fixture.keys.bob);
    const bobSession = acceptSession(fixture.conversationId, fixture.aliceId, fixture.init.sessionId, bob, {
      ephPub: fixture.init.ephPub,
      ik: fixture.init.ik,
      spkId: fixture.init.spkId,
    });
    expect(vi.mocked(generateX25519)).not.toHaveBeenCalled();
    expect({ ckInit: bobSession.ckInit, ckResp: bobSession.ckResp }).toEqual(fixture.chains);

    for (const m of fixture.messages.filter((x) => x.dir === "alice->bob")) {
      expect(open(bobSession, fixture.conversationId, fixture.aliceId, m.envelope)).toBe(m.plaintext);
    }
    // …and Bob's own replies via openOwn on his chain
    for (const m of fixture.messages.filter((x) => x.dir === "bob->alice")) {
      expect(openOwn(bobSession, fixture.conversationId, fixture.bobId, m.envelope)).toBe(m.plaintext);
    }
  });

  it("fixture envelopes are bound to their metadata: wrong conversation / sender / ctr / session fail", () => {
    const sessions = establish(fixture.keys, fixture.init.sessionId);
    const m = fixture.messages[2]!; // alice->bob ctr=1
    const { senderId, receiver } = sealerFor(m.dir, sessions);

    expect(() => open(receiver, "other-conv", senderId, m.envelope)).toThrow();
    expect(() => open(receiver, fixture.conversationId, "mallory", m.envelope)).toThrow();
    expect(() => open(receiver, fixture.conversationId, senderId, { ...m.envelope, ctr: 2 })).toThrow();
    expect(() => open(receiver, fixture.conversationId, senderId, { ...m.envelope, sessionId: "x" })).toThrow(
      /mismatch/i
    );
  });
});
