/**
 * Cryptographic primitives for the E2EE layer — one thin, synchronous
 * interface over audited implementations (@noble/curves, @noble/hashes,
 * @noble/ciphers). Everything above this file composes these; nothing above
 * it touches a crypto library directly.
 *
 * Design note (ADR: why noble over WebCrypto for the core):
 * WebCrypto's X25519/Ed25519 support is still uneven across browsers and its
 * async, CryptoKey-object API complicates the counter-addressed ratchet.
 * noble is audited, dependency-free, and byte-for-byte testable against the
 * RFC vectors (see primitives.test.ts). WebCrypto IS used where its
 * non-extractability actually buys something: the at-rest wrapping key in
 * keyStore.ts.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/hashes/utils.js";

// ── Random ────────────────────────────────────────────────────────────────────

export { randomBytes };

// ── Encoding ──────────────────────────────────────────────────────────────────

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

// ── X25519 (Diffie-Hellman) ───────────────────────────────────────────────────

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function generateX25519(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/** Raw X25519 shared secret. Never used directly as a key — always through HKDF. */
export function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(privateKey, publicKey);
}

// ── Ed25519 (signatures) ──────────────────────────────────────────────────────

export function generateEd25519(): KeyPair {
  const privateKey = ed25519.utils.randomSecretKey();
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
}

export function sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, privateKey);
}

export function verify(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

// ── Hashing / KDF / MAC ───────────────────────────────────────────────────────

export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | undefined,
  info: string,
  length: number
): Uint8Array {
  return hkdf(sha256, ikm, salt, utf8Encode(info), length);
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha256, key, data);
}

export function hashSha256(data: Uint8Array): Uint8Array {
  return sha256(data);
}

export function hashSha512(data: Uint8Array): Uint8Array {
  return sha512(data);
}

// ── AES-256-GCM ───────────────────────────────────────────────────────────────

/** Encrypt: returns ciphertext with the 16-byte GCM tag appended. */
export function aesGcmEncrypt(
  key: Uint8Array, // 32 bytes
  iv: Uint8Array, // 12 bytes
  plaintext: Uint8Array,
  aad?: Uint8Array
): Uint8Array {
  return gcm(key, iv, aad).encrypt(plaintext);
}

/** Decrypt: throws on any tag/AAD mismatch. */
export function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertextWithTag: Uint8Array,
  aad?: Uint8Array
): Uint8Array {
  return gcm(key, iv, aad).decrypt(ciphertextWithTag);
}

// ── Comparison ────────────────────────────────────────────────────────────────

/** Constant-time byte equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}
