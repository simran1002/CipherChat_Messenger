/**
 * Envelope v2 — Double Ratchet sessions on the wire.
 *
 *   { v: 2, sessionId, ctr, dh, pn, n, ct, init? }
 *
 * `dh/pn/n` are the ratchet header. `sessionId` + `ctr` are kept from v1 on purpose: `ctr` is the
 * sender's monotonic send count on the session, so the server's replay backstop
 * UNIQUE(conversation, sender, sessionId, ctr) keeps working without understanding the ratchet.
 * The associated data binds the ciphertext to the conversation, the sender, the session and the
 * counter, exactly as v1 does; the ratchet header is bound inside ratchetEncrypt().
 *
 * Session establishment reuses the same X3DH inputs as v1 (identity key, signed prekey, one
 * ephemeral key) with a distinct KDF label, so a v1 and a v2 session between the same two people
 * can never derive the same secret. The responder's first ratchet key pair is its signed prekey.
 */
import { concatBytes, dh, fromBase64, generateX25519, hkdfSha256, toBase64, utf8Encode } from "./primitives";
import { initInitiator, initResponder, ratchetDecrypt, ratchetEncrypt } from "./doubleRatchet";
import { verifyBundle, type PeerBundle } from "./session";
import type { StoredIdentity } from "./keyStore";
import type { RatchetSession } from "./vault";

const X3DH_INFO_V2 = "cipher-msgr/x3dh/v2-double-ratchet";

export interface WireEnvelopeV2 {
  v: 2;
  sessionId: string;
  ctr: number;
  dh: string;
  pn: number;
  n: number;
  ct: string;
  init?: { ephPub: string; ik: string; spkId: number };
}

function aad(conversationId: string, senderId: string, sessionId: string, ctr: number): Uint8Array {
  return utf8Encode(
    `{"v":2,"conversationId":"${conversationId}","senderId":"${senderId}","sessionId":"${sessionId}","ctr":${ctr}}`
  );
}

function sharedSecret(dh1: Uint8Array, dh2: Uint8Array, dh3: Uint8Array): Uint8Array {
  return hkdfSha256(concatBytes(dh1, dh2, dh3), undefined, X3DH_INFO_V2, 32);
}

/** Initiator: verify the peer's signed prekey, run X3DH, start the ratchet toward that prekey. */
export function startInitiator(conversationId: string, peerId: string, identity: StoredIdentity, bundle: PeerBundle): RatchetSession {
  if (!verifyBundle(bundle)) throw new Error("Peer prekey signature invalid — refusing to establish session");
  const ek = generateX25519();
  const spkB = fromBase64(bundle.signedPreKey.pubX25519);
  const ikB = fromBase64(bundle.identityX25519);
  const sk = sharedSecret(dh(fromBase64(identity.xPriv), spkB), dh(ek.privateKey, ikB), dh(ek.privateKey, spkB));
  return {
    sessionId: crypto.randomUUID(),
    conversationId,
    peerId,
    role: "init",
    createdAt: Date.now(),
    sendTotal: 0,
    peerReplied: false,
    init: { ephPub: toBase64(ek.publicKey), ik: identity.xPub, spkId: bundle.signedPreKey.keyId },
    state: initInitiator(sk, spkB),
  };
}

/** Responder: derive the same secret from the init block; the signed prekey is the first ratchet key. */
export function startResponder(
  conversationId: string,
  peerId: string,
  sessionId: string,
  identity: StoredIdentity,
  init: { ephPub: string; ik: string; spkId: number }
): RatchetSession {
  if (init.spkId !== identity.spkId) throw new Error(`Unknown signed prekey id ${init.spkId}`);
  const spkPriv = fromBase64(identity.spkPriv);
  const ikA = fromBase64(init.ik);
  const ekA = fromBase64(init.ephPub);
  const sk = sharedSecret(dh(spkPriv, ikA), dh(fromBase64(identity.xPriv), ekA), dh(spkPriv, ekA));
  return {
    sessionId,
    conversationId,
    peerId,
    role: "resp",
    createdAt: Date.now(),
    sendTotal: 0,
    peerReplied: true,
    state: initResponder(sk, spkPriv, fromBase64(identity.spkPub)),
  };
}

/** Encrypt one message. Persist `next` (with the plaintext) BEFORE the envelope leaves the device. */
export function sealV2(session: RatchetSession, senderId: string, text: string): { envelope: WireEnvelopeV2; next: RatchetSession } {
  const ctr = session.sendTotal;
  const { message, next } = ratchetEncrypt(session.state, text, aad(session.conversationId, senderId, session.sessionId, ctr));
  const envelope: WireEnvelopeV2 = {
    v: 2,
    sessionId: session.sessionId,
    ctr,
    dh: message.header.dh,
    pn: message.header.pn,
    n: message.header.n,
    ct: toBase64(message.ciphertext),
  };
  // The init block rides along until the peer has answered: the first frame may be lost or arrive late.
  if (session.role === "init" && !session.peerReplied && session.init) envelope.init = session.init;
  return { envelope, next: { ...session, sendTotal: ctr + 1, state: next } };
}

/** Decrypt a peer's message. Throws RatchetError without touching `session` when the frame is not authentic. */
export function openV2(session: RatchetSession, senderId: string, envelope: WireEnvelopeV2): { text: string; next: RatchetSession } {
  if (envelope.sessionId !== session.sessionId) throw new Error("Envelope/session mismatch");
  const { plaintext, next } = ratchetDecrypt(
    session.state,
    { header: { dh: envelope.dh, pn: envelope.pn, n: envelope.n }, ciphertext: fromBase64(envelope.ct) },
    aad(session.conversationId, senderId, envelope.sessionId, envelope.ctr)
  );
  return { text: plaintext, next: { ...session, peerReplied: true, state: next } };
}
