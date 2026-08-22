/**
 * Interchangeability proof: the noble-backed primitives produce byte-identical
 * output to the platform WebCrypto implementation (globalThis.crypto.subtle —
 * Node's in tests, the browser's in production), and each side can decrypt
 * the other's ciphertext. This is what lets a second client (or a future
 * WebCrypto-only build) interoperate with envelopes sealed by this code.
 *
 * Known-answer vectors are shared with primitives.test.ts (NIST GCM, RFC 5869
 * A.1, RFC 4231 #2, RFC 7748 §6.1); random cases cover arbitrary lengths.
 */
import { describe, expect, it } from "vitest";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { aesGcmDecrypt, aesGcmEncrypt, dh, generateX25519, hkdfSha256, hmacSha256, utf8Encode } from "./primitives";

const subtle = globalThis.crypto.subtle;

function hex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function rand(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlEncode(b: Uint8Array): string {
  let bin = "";
  b.forEach((x) => (bin += String.fromCharCode(x)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const buf = (b: Uint8Array) => b as BufferSource;

// ── WebCrypto wrappers (mirror the sync noble API) ───────────────────────────

async function wcAesGcmEncrypt(key: Uint8Array, iv: Uint8Array, pt: Uint8Array, aad?: Uint8Array) {
  const k = await subtle.importKey("raw", buf(key), "AES-GCM", false, ["encrypt"]);
  const params: AesGcmParams = { name: "AES-GCM", iv: buf(iv), tagLength: 128 };
  if (aad) params.additionalData = buf(aad);
  return new Uint8Array(await subtle.encrypt(params, k, buf(pt)));
}

async function wcAesGcmDecrypt(key: Uint8Array, iv: Uint8Array, ctWithTag: Uint8Array, aad?: Uint8Array) {
  const k = await subtle.importKey("raw", buf(key), "AES-GCM", false, ["decrypt"]);
  const params: AesGcmParams = { name: "AES-GCM", iv: buf(iv), tagLength: 128 };
  if (aad) params.additionalData = buf(aad);
  return new Uint8Array(await subtle.decrypt(params, k, buf(ctWithTag)));
}

async function wcHkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) {
  const k = await subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(info) }, k, length * 8);
  return new Uint8Array(bits);
}

async function wcHmacSha256(key: Uint8Array, data: Uint8Array) {
  const k = await subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, buf(data)));
}

// ── AES-256-GCM ──────────────────────────────────────────────────────────────

describe("AES-256-GCM — noble ⇄ WebCrypto", () => {
  // Same NIST (McGrew-Viega test case 16 pattern) vector as primitives.test.ts
  const nist = {
    key: hex("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308"),
    iv: hex("cafebabefacedbaddecaf888"),
    pt: hex(
      "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39"
    ),
    aad: hex("feedfacedeadbeeffeedfacedeadbeefabaddad2"),
    ct: hex(
      "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662"
    ),
    tag: hex("76fc6ece0f4e1768cddf8853bb2d551b"),
  };

  it("NIST vector: both implementations produce the reference ct||tag", async () => {
    const noble = aesGcmEncrypt(nist.key, nist.iv, nist.pt, nist.aad);
    const wc = await wcAesGcmEncrypt(nist.key, nist.iv, nist.pt, nist.aad);
    const expected = toHex(nist.ct) + toHex(nist.tag);
    expect(toHex(noble)).toBe(expected);
    expect(toHex(wc)).toBe(expected);
  });

  const randomCases = [
    { name: "1-byte plaintext, with AAD", ptLen: 1, aadLen: 20 },
    { name: "100-byte plaintext, no AAD", ptLen: 100, aadLen: 0 },
    { name: "1000-byte plaintext (multi-block), with AAD", ptLen: 1000, aadLen: 7 },
  ];

  for (const c of randomCases) {
    it(`random: ${c.name} — identical ciphertext and cross-decryptable`, async () => {
      const key = rand(32);
      const iv = rand(12);
      const pt = rand(c.ptLen);
      const aad = c.aadLen ? rand(c.aadLen) : undefined;

      const noble = aesGcmEncrypt(key, iv, pt, aad);
      const wc = await wcAesGcmEncrypt(key, iv, pt, aad);
      expect(noble.length).toBe(c.ptLen + 16);
      expect(toHex(wc)).toBe(toHex(noble));

      // WebCrypto decrypts noble's output and vice-versa
      expect(toHex(await wcAesGcmDecrypt(key, iv, noble, aad))).toBe(toHex(pt));
      expect(toHex(aesGcmDecrypt(key, iv, wc, aad))).toBe(toHex(pt));
    });
  }

  it("both implementations reject a tampered tag from the other side", async () => {
    const key = rand(32);
    const iv = rand(12);
    const pt = rand(64);
    const aad = rand(8);

    const fromNoble = aesGcmEncrypt(key, iv, pt, aad);
    fromNoble[fromNoble.length - 1]! ^= 0x01;
    await expect(wcAesGcmDecrypt(key, iv, fromNoble, aad)).rejects.toThrow();

    const fromWc = await wcAesGcmEncrypt(key, iv, pt, aad);
    fromWc[fromWc.length - 1]! ^= 0x01;
    expect(() => aesGcmDecrypt(key, iv, fromWc, aad)).toThrow();

    // AAD mismatch is also detected across implementations
    const good = await wcAesGcmEncrypt(key, iv, pt, aad);
    const wrongAad = new Uint8Array(aad);
    wrongAad[0]! ^= 0x01;
    expect(() => aesGcmDecrypt(key, iv, good, wrongAad)).toThrow();
  });
});

// ── HKDF-SHA256 ──────────────────────────────────────────────────────────────

describe("HKDF-SHA256 — noble ⇄ WebCrypto", () => {
  it("RFC 5869 A.1: both derive the reference OKM (raw-byte info)", async () => {
    const ikm = hex("0b".repeat(22));
    const salt = hex("000102030405060708090a0b0c");
    const info = hex("f0f1f2f3f4f5f6f7f8f9");
    const okm = "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865";

    expect(toHex(hkdf(sha256, ikm, salt, info, 42))).toBe(okm);
    expect(toHex(await wcHkdfSha256(ikm, salt, info, 42))).toBe(okm);
  });

  it("random ikm/salt with UTF-8 info through the hkdfSha256 wrapper matches WebCrypto", async () => {
    const ikm = rand(32);
    const salt = rand(16);
    const info = "cipher-msgr/webcrypto-interop";
    for (const length of [32, 44, 64]) {
      const noble = hkdfSha256(ikm, salt, info, length);
      const wc = await wcHkdfSha256(ikm, salt, utf8Encode(info), length);
      expect(noble.length).toBe(length);
      expect(toHex(wc)).toBe(toHex(noble));
    }
  });

  it("salt=undefined (noble) ≡ empty salt (WebCrypto) — the RFC 5869 zero-salt default the ratchet relies on", async () => {
    // session.ts derives chains with `salt: undefined`; a WebCrypto port must
    // pass an empty salt to get the same bytes.
    const ikm = rand(96); // 3 concatenated DH outputs, as in X3DH-lite
    const noble = hkdfSha256(ikm, undefined, "cipher-msgr/x3dh-lite/v1", 32);
    const wc = await wcHkdfSha256(ikm, new Uint8Array(0), utf8Encode("cipher-msgr/x3dh-lite/v1"), 32);
    const wcZeroSalt = await wcHkdfSha256(ikm, new Uint8Array(32), utf8Encode("cipher-msgr/x3dh-lite/v1"), 32);
    expect(toHex(wc)).toBe(toHex(noble));
    expect(toHex(wcZeroSalt)).toBe(toHex(noble));
  });
});

// ── HMAC-SHA256 ──────────────────────────────────────────────────────────────

describe("HMAC-SHA256 — noble ⇄ WebCrypto", () => {
  it("RFC 4231 test case 2: both produce the reference tag", async () => {
    const key = utf8Encode("Jefe");
    const data = utf8Encode("what do ya want for nothing?");
    const tag = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
    expect(toHex(hmacSha256(key, data))).toBe(tag);
    expect(toHex(await wcHmacSha256(key, data))).toBe(tag);
  });

  it("random key/data (incl. the chain-step input used by messageKeyAt) match", async () => {
    const key = rand(32);
    for (const data of [rand(1), rand(200), new Uint8Array([0x02]) /* CHAIN_STEP */]) {
      expect(toHex(await wcHmacSha256(key, data))).toBe(toHex(hmacSha256(key, data)));
    }
  });

  it("a full chain walk (HMAC iterated 50×) agrees byte-for-byte", async () => {
    let noble = rand(32);
    let wc = new Uint8Array(noble);
    const step = new Uint8Array([0x02]);
    for (let i = 0; i < 50; i++) {
      noble = hmacSha256(noble, step);
      wc = await wcHmacSha256(wc, step);
    }
    expect(toHex(wc)).toBe(toHex(noble));
  });
});

// ── X25519 (optional — depends on runtime WebCrypto support) ─────────────────

async function probeWebCryptoX25519(): Promise<boolean> {
  try {
    const pair = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    return Boolean(pair?.privateKey && pair?.publicKey);
  } catch {
    return false;
  }
}

const X25519_SUPPORTED = await probeWebCryptoX25519();
const x25519Suffix = X25519_SUPPORTED ? "" : " (SKIPPED: this runtime's WebCrypto has no X25519 — interop proof unavailable here)";

describe(`X25519 — noble ⇄ WebCrypto${x25519Suffix}`, () => {
  it.skipIf(!X25519_SUPPORTED)("WebCrypto keypair vs noble keypair derive the same shared secret", async () => {
    const wcPair = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    const noblePair = generateX25519();

    // Export WebCrypto's keys in raw form: public = raw, private = JWK `d`
    const wcPubRaw = new Uint8Array(await subtle.exportKey("raw", wcPair.publicKey));
    const wcJwk = await subtle.exportKey("jwk", wcPair.privateKey);
    const wcPrivRaw = b64urlDecode(wcJwk.d!);
    expect(wcPubRaw).toHaveLength(32);
    expect(wcPrivRaw).toHaveLength(32);

    // Import noble's public key into WebCrypto
    const noblePubKey = await subtle.importKey("raw", buf(noblePair.publicKey), { name: "X25519" }, true, []);

    const wcShared = new Uint8Array(
      await subtle.deriveBits({ name: "X25519", public: noblePubKey } as EcdhKeyDeriveParams, wcPair.privateKey, 256)
    );
    const nobleShared = dh(noblePair.privateKey, wcPubRaw);
    const nobleSharedFromWcPriv = dh(wcPrivRaw, noblePair.publicKey);

    expect(wcShared).toHaveLength(32);
    expect(toHex(nobleShared)).toBe(toHex(wcShared));
    expect(toHex(nobleSharedFromWcPriv)).toBe(toHex(wcShared));
  });

  it.skipIf(!X25519_SUPPORTED)("RFC 7748 §6.1 vector through WebCrypto matches noble's dh()", async () => {
    const alicePriv = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
    const alicePub = hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
    const bobPub = hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
    const sharedK = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";

    const alicePrivKey = await subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "X25519", d: b64urlEncode(alicePriv), x: b64urlEncode(alicePub) },
      { name: "X25519" },
      false,
      ["deriveBits"]
    );
    const bobPubKey = await subtle.importKey("raw", buf(bobPub), { name: "X25519" }, true, []);
    const wcShared = new Uint8Array(
      await subtle.deriveBits({ name: "X25519", public: bobPubKey } as EcdhKeyDeriveParams, alicePrivKey, 256)
    );

    expect(toHex(wcShared)).toBe(sharedK);
    expect(toHex(dh(alicePriv, bobPub))).toBe(sharedK);
  });
});
