/**
 * Seal/open: plaintext ↔ wire envelope.
 *
 * AAD binds the ciphertext to its routing metadata — moving a ciphertext to
 * another conversation, another sender, another session, or another counter
 * slot breaks the GCM tag. The IV is derived with the message key (never
 * transmitted), so nonce reuse is structurally impossible. Plaintext is
 * padded to 256-byte buckets to blunt length analysis.
 */
import { aesGcmDecrypt, aesGcmEncrypt, fromBase64, toBase64, utf8Decode, utf8Encode } from "./primitives";
import { messageKeyAt, receiveChainRoot, sendChainRoot } from "./session";
import type { StoredSession } from "./keyStore";

export interface WireEnvelope {
  v: 1;
  sessionId: string;
  ctr: number;
  ct: string; // b64: padded plaintext ciphertext + 16B GCM tag
  init?: { ephPub: string; ik: string; spkId: number };
}

const PAD_BUCKET = 256;

/** Canonical AAD — field order is part of the protocol, never reorder. */
function buildAad(conversationId: string, senderId: string, sessionId: string, ctr: number): Uint8Array {
  return utf8Encode(
    `{"v":1,"conversationId":"${conversationId}","senderId":"${senderId}","sessionId":"${sessionId}","ctr":${ctr}}`
  );
}

/** Pad: [2B big-endian length][utf8 plaintext][zeros to bucket boundary]. */
function pad(plaintext: string): Uint8Array {
  const body = utf8Encode(plaintext);
  if (body.length > 0xffff) throw new Error("Plaintext too long");
  const total = Math.max(PAD_BUCKET, Math.ceil((body.length + 2) / PAD_BUCKET) * PAD_BUCKET);
  const out = new Uint8Array(total);
  out[0] = (body.length >> 8) & 0xff;
  out[1] = body.length & 0xff;
  out.set(body, 2);
  return out;
}

function unpad(padded: Uint8Array): string {
  if (padded.length < 2) throw new Error("Corrupt padding");
  const len = ((padded[0]! << 8) | padded[1]!) >>> 0;
  if (len + 2 > padded.length) throw new Error("Corrupt padding");
  return utf8Decode(padded.slice(2, 2 + len));
}

/** Encrypt plaintext at the session's given send counter. */
export function seal(
  session: StoredSession,
  conversationId: string,
  senderId: string,
  ctr: number,
  plaintext: string,
  init?: WireEnvelope["init"]
): WireEnvelope {
  const { key, iv } = messageKeyAt(sendChainRoot(session), ctr);
  const aad = buildAad(conversationId, senderId, session.sessionId, ctr);
  const ct = aesGcmEncrypt(key, iv, pad(plaintext), aad);
  const envelope: WireEnvelope = { v: 1, sessionId: session.sessionId, ctr, ct: toBase64(ct) };
  if (init && ctr === 0) envelope.init = init;
  return envelope;
}

/** Decrypt an envelope produced by the PEER of this session. Throws on tamper. */
export function open(
  session: StoredSession,
  conversationId: string,
  senderId: string,
  envelope: WireEnvelope
): string {
  if (envelope.v !== 1) throw new Error(`Unsupported envelope version ${envelope.v}`);
  if (envelope.sessionId !== session.sessionId) throw new Error("Envelope/session mismatch");
  const { key, iv } = messageKeyAt(receiveChainRoot(session), envelope.ctr);
  const aad = buildAad(conversationId, senderId, envelope.sessionId, envelope.ctr);
  const padded = aesGcmDecrypt(key, iv, fromBase64(envelope.ct), aad);
  return unpad(padded);
}

/** Decrypt our OWN sent envelope (history rendering). */
export function openOwn(
  session: StoredSession,
  conversationId: string,
  senderId: string,
  envelope: WireEnvelope
): string {
  if (envelope.v !== 1) throw new Error(`Unsupported envelope version ${envelope.v}`);
  if (envelope.sessionId !== session.sessionId) throw new Error("Envelope/session mismatch");
  const { key, iv } = messageKeyAt(sendChainRoot(session), envelope.ctr);
  const aad = buildAad(conversationId, senderId, envelope.sessionId, envelope.ctr);
  const padded = aesGcmDecrypt(key, iv, fromBase64(envelope.ct), aad);
  return unpad(padded);
}
