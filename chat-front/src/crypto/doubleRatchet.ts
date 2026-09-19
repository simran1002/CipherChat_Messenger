/**
 * Double Ratchet (Signal specification, rev. 1) over this project's primitives:
 * X25519 for the DH ratchet, HKDF-SHA256 for the root chain, HMAC-SHA256 for the symmetric chains,
 * AES-256-GCM for the payload with the header bound as associated data.
 *
 * What it adds over the v1 chain sessions (ADR-0003 → superseded by ADR-0011):
 *   - forward secrecy PER MESSAGE: a message key is derived, used once and zeroised; the chain key
 *     it came from is overwritten, so a device seized later cannot open earlier ciphertext;
 *   - post-compromise security: every change of speaking direction mixes a fresh DH output into
 *     the root key with fresh randomness, so an attacker holding a copy of the state is locked
 *     out as soon as the victim uses a ratchet key generated after the theft (at most two round trips).
 *
 * Properties this file is careful about:
 *   - decrypt() is transactional: it works on a copy and the caller's state only changes when
 *     the AEAD tag verified — a forged or corrupted frame cannot advance or poison the ratchet;
 *   - skipped message keys (out-of-order delivery, offline queues) are bounded per step
 *     (MAX_SKIP) and in total (MAX_STORED_SKIPPED, oldest evicted), and carry a timestamp so the
 *     caller can expire them;
 *   - state is plain data (base64 strings) so it can be wrapped and persisted as one unit with
 *     whatever else must commit atomically with it.
 */
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  concatBytes,
  dh,
  fromBase64,
  generateX25519,
  hkdfSha256,
  hmacSha256,
  toBase64,
  utf8Decode,
  utf8Encode,
} from "./primitives";

export const MAX_SKIP = 1000;
export const MAX_STORED_SKIPPED = 2000;

const INFO_ROOT = "cipherchat/dr/v2/root";
const INFO_MESSAGE = "cipherchat/dr/v2/message";
const CHAIN_MESSAGE = new Uint8Array([0x01]);
const CHAIN_NEXT = new Uint8Array([0x02]);

export interface RatchetHeader {
  /** Sender's current ratchet public key (b64). */
  dh: string;
  /** Length of the sender's previous sending chain. */
  pn: number;
  /** Message number within the current sending chain. */
  n: number;
}

export interface SkippedKey {
  dh: string;
  n: number;
  mk: string;
  at: number;
}

export interface RatchetState {
  dhsPriv: string;
  dhsPub: string;
  dhr: string | null;
  rk: string;
  cks: string | null;
  ckr: string | null;
  ns: number;
  nr: number;
  pn: number;
  skipped: SkippedKey[];
}

export class RatchetError extends Error {
  constructor(
    public readonly code: "too_many_skipped" | "auth_failed" | "no_sending_chain" | "duplicate_or_expired",
    message: string
  ) {
    super(message);
  }
}

// ── KDFs ──────────────────────────────────────────────────────────────────────

function kdfRoot(rk: Uint8Array, dhOut: Uint8Array): { rk: Uint8Array; ck: Uint8Array } {
  const okm = hkdfSha256(dhOut, rk, INFO_ROOT, 64);
  return { rk: okm.slice(0, 32), ck: okm.slice(32, 64) };
}

function kdfChain(ck: Uint8Array): { ck: Uint8Array; mk: Uint8Array } {
  return { mk: hmacSha256(ck, CHAIN_MESSAGE), ck: hmacSha256(ck, CHAIN_NEXT) };
}

function cipherParams(mk: Uint8Array): { key: Uint8Array; iv: Uint8Array } {
  const okm = hkdfSha256(mk, undefined, INFO_MESSAGE, 44);
  return { key: okm.slice(0, 32), iv: okm.slice(32, 44) };
}

function zero(...buffers: Uint8Array[]): void {
  for (const b of buffers) b.fill(0);
}

function headerBytes(h: RatchetHeader): Uint8Array {
  return utf8Encode(`{"dh":"${h.dh}","pn":${h.pn},"n":${h.n}}`);
}

// ── Initialisation ────────────────────────────────────────────────────────────

/** Initiator: knows the shared secret from X3DH and the responder's ratchet public key (their signed prekey). */
export function initInitiator(sharedSecret: Uint8Array, responderRatchetPub: Uint8Array): RatchetState {
  const dhs = generateX25519();
  const { rk, ck } = kdfRoot(sharedSecret, dh(dhs.privateKey, responderRatchetPub));
  return {
    dhsPriv: toBase64(dhs.privateKey),
    dhsPub: toBase64(dhs.publicKey),
    dhr: toBase64(responderRatchetPub),
    rk: toBase64(rk),
    cks: toBase64(ck),
    ckr: null,
    ns: 0,
    nr: 0,
    pn: 0,
    skipped: [],
  };
}

/** Responder: its first ratchet key pair is the signed prekey the initiator used. */
export function initResponder(sharedSecret: Uint8Array, ratchetPriv: Uint8Array, ratchetPub: Uint8Array): RatchetState {
  return {
    dhsPriv: toBase64(ratchetPriv),
    dhsPub: toBase64(ratchetPub),
    dhr: null,
    rk: toBase64(sharedSecret),
    cks: null,
    ckr: null,
    ns: 0,
    nr: 0,
    pn: 0,
    skipped: [],
  };
}

// ── Encrypt ───────────────────────────────────────────────────────────────────

export interface RatchetMessage {
  header: RatchetHeader;
  /** AES-256-GCM ciphertext with tag. */
  ciphertext: Uint8Array;
}

/**
 * Returns the message and the NEXT state. The caller must persist the next state before the
 * ciphertext leaves the device — a crash then burns a message number instead of reusing a key.
 */
export function ratchetEncrypt(state: RatchetState, plaintext: string, associatedData: Uint8Array): { message: RatchetMessage; next: RatchetState } {
  if (!state.cks) throw new RatchetError("no_sending_chain", "Responder cannot send before receiving the first message.");
  const { ck, mk } = kdfChain(fromBase64(state.cks));
  const header: RatchetHeader = { dh: state.dhsPub, pn: state.pn, n: state.ns };
  const { key, iv } = cipherParams(mk);
  const ciphertext = aesGcmEncrypt(key, iv, utf8Encode(plaintext), concatBytes(associatedData, headerBytes(header)));
  zero(mk, key);
  return { message: { header, ciphertext }, next: { ...state, cks: toBase64(ck), ns: state.ns + 1, skipped: [...state.skipped] } };
}

// ── Decrypt ───────────────────────────────────────────────────────────────────

function tryOpen(mk: Uint8Array, message: RatchetMessage, associatedData: Uint8Array): string {
  const { key, iv } = cipherParams(mk);
  try {
    return utf8Decode(aesGcmDecrypt(key, iv, message.ciphertext, concatBytes(associatedData, headerBytes(message.header))));
  } catch {
    throw new RatchetError("auth_failed", "Message failed authentication.");
  } finally {
    zero(key);
  }
}

function skipUntil(state: RatchetState, until: number, now: number): void {
  if (!state.ckr) return;
  if (until - state.nr > MAX_SKIP) {
    throw new RatchetError("too_many_skipped", `Refusing to skip ${until - state.nr} message keys (limit ${MAX_SKIP}).`);
  }
  let ck = fromBase64(state.ckr);
  while (state.nr < until) {
    const step = kdfChain(ck);
    state.skipped.push({ dh: state.dhr!, n: state.nr, mk: toBase64(step.mk), at: now });
    zero(step.mk);
    ck = step.ck;
    state.nr += 1;
  }
  state.ckr = toBase64(ck);
  if (state.skipped.length > MAX_STORED_SKIPPED) {
    state.skipped.splice(0, state.skipped.length - MAX_STORED_SKIPPED); // oldest first
  }
}

function dhRatchet(state: RatchetState, header: RatchetHeader): void {
  state.pn = state.ns;
  state.ns = 0;
  state.nr = 0;
  state.dhr = header.dh;
  const theirs = fromBase64(header.dh);
  const recv = kdfRoot(fromBase64(state.rk), dh(fromBase64(state.dhsPriv), theirs));
  state.ckr = toBase64(recv.ck);
  const fresh = generateX25519(); // new randomness: this is the step that locks a state thief out
  const send = kdfRoot(recv.rk, dh(fresh.privateKey, theirs));
  state.dhsPriv = toBase64(fresh.privateKey);
  state.dhsPub = toBase64(fresh.publicKey);
  state.rk = toBase64(send.rk);
  state.cks = toBase64(send.ck);
}

/**
 * Transactional: on any failure the input state is untouched and an error is thrown; on success
 * the returned `next` state has consumed (and forgotten) the message key.
 */
export function ratchetDecrypt(
  state: RatchetState,
  message: RatchetMessage,
  associatedData: Uint8Array,
  now: number = Date.now()
): { plaintext: string; next: RatchetState } {
  const work: RatchetState = { ...state, skipped: state.skipped.map((s) => ({ ...s })) };
  const { header } = message;

  const at = work.skipped.findIndex((s) => s.dh === header.dh && s.n === header.n);
  if (at >= 0) {
    const mk = fromBase64(work.skipped[at]!.mk);
    const plaintext = tryOpen(mk, message, associatedData);
    zero(mk);
    work.skipped.splice(at, 1);
    return { plaintext, next: work };
  }

  if (header.dh !== work.dhr) {
    skipUntil(work, header.pn, now);
    dhRatchet(work, header);
  } else if (header.n < work.nr) {
    // Same chain, number already consumed and not among the skipped keys: a replay, or a key that expired.
    throw new RatchetError("duplicate_or_expired", "Message key already used or no longer held.");
  }

  skipUntil(work, header.n, now);
  const step = kdfChain(fromBase64(work.ckr!));
  const plaintext = tryOpen(step.mk, message, associatedData);
  zero(step.mk);
  work.ckr = toBase64(step.ck);
  work.nr += 1;
  return { plaintext, next: work };
}

/** Drop skipped keys older than maxAgeMs. Returns how many were removed. */
export function expireSkipped(state: RatchetState, maxAgeMs: number, now: number = Date.now()): { next: RatchetState; removed: number } {
  const kept = state.skipped.filter((s) => now - s.at <= maxAgeMs);
  return { next: { ...state, skipped: kept }, removed: state.skipped.length - kept.length };
}
