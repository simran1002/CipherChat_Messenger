/**
 * Session establishment (X3DH-lite) and the per-direction symmetric chain
 * ratchet. Megolm-style: forward secrecy at session granularity — sessions
 * rotate every ROTATE_AFTER_MESSAGES / ROTATE_AFTER_MS; decryption is
 * counter-addressed so out-of-order delivery, offline queues, and history
 * replay need no skipped-key bookkeeping.
 */
import {
  concatBytes,
  dh,
  fromBase64,
  generateX25519,
  hkdfSha256,
  hmacSha256,
  toBase64,
  verify,
} from "./primitives";
import type { StoredIdentity, StoredSession } from "./keyStore";

export const ROTATE_AFTER_MESSAGES = 200;
export const ROTATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const X3DH_INFO = "cipher-msgr/x3dh-lite/v1";
const CHAIN_STEP = new Uint8Array([0x02]);

export interface PeerBundle {
  identityEd25519: string; // b64
  identityX25519: string;
  signedPreKey: { keyId: number; pubX25519: string; sig: string };
}

/** Verify the peer's prekey really is signed by their identity key. */
export function verifyBundle(bundle: PeerBundle): boolean {
  return verify(
    fromBase64(bundle.identityEd25519),
    fromBase64(bundle.signedPreKey.sig),
    fromBase64(bundle.signedPreKey.pubX25519)
  );
}

interface DerivedChains {
  ckInit: Uint8Array;
  ckResp: Uint8Array;
}

/** SK = HKDF( DH(IK_A,SPK_B) || DH(EK_A,IK_B) || DH(EK_A,SPK_B) ) → two chain roots. */
function deriveChains(dh1: Uint8Array, dh2: Uint8Array, dh3: Uint8Array): DerivedChains {
  const sk = hkdfSha256(concatBytes(dh1, dh2, dh3), undefined, X3DH_INFO, 32);
  return {
    ckInit: hkdfSha256(sk, undefined, "init->resp", 32),
    ckResp: hkdfSha256(sk, undefined, "resp->init", 32),
  };
}

export interface InitiatedSession {
  session: StoredSession;
  /** Goes into the first envelope so the responder can derive the same SK. */
  init: { ephPub: string; ik: string; spkId: number };
}

/** Initiator side: establish a session toward a peer's published bundle. */
export function initiateSession(
  conversationId: string,
  peerId: string,
  identity: StoredIdentity,
  bundle: PeerBundle
): InitiatedSession {
  if (!verifyBundle(bundle)) {
    throw new Error("Peer prekey signature invalid — refusing to establish session");
  }

  const ek = generateX25519();
  const ikPriv = fromBase64(identity.xPriv);
  const spkB = fromBase64(bundle.signedPreKey.pubX25519);
  const ikB = fromBase64(bundle.identityX25519);

  const chains = deriveChains(dh(ikPriv, spkB), dh(ek.privateKey, ikB), dh(ek.privateKey, spkB));

  const session: StoredSession = {
    sessionId: crypto.randomUUID(),
    conversationId,
    peerId,
    role: "init",
    ckInit: toBase64(chains.ckInit),
    ckResp: toBase64(chains.ckResp),
    sendCtr: 0,
    peerMaxCtr: -1,
    createdAt: Date.now(),
  };

  return {
    session,
    init: {
      ephPub: toBase64(ek.publicKey),
      ik: toBase64(fromBase64(identity.xPub)),
      spkId: bundle.signedPreKey.keyId,
    },
  };
}

/** Responder side: accept a session from the first envelope's init block. */
export function acceptSession(
  conversationId: string,
  peerId: string,
  sessionId: string,
  identity: StoredIdentity,
  init: { ephPub: string; ik: string; spkId: number }
): StoredSession {
  if (init.spkId !== identity.spkId) {
    // Prekey has rotated since the initiator fetched the bundle. v1 keeps a
    // single live prekey; the initiator will retry after refreshing.
    throw new Error(`Unknown signed prekey id ${init.spkId}`);
  }

  const spkPriv = fromBase64(identity.spkPriv);
  const ikPriv = fromBase64(identity.xPriv);
  const ikA = fromBase64(init.ik);
  const ekA = fromBase64(init.ephPub);

  // Same three DH inputs, computed from the responder's private keys
  const chains = deriveChains(dh(spkPriv, ikA), dh(ikPriv, ekA), dh(spkPriv, ekA));

  return {
    sessionId,
    conversationId,
    peerId,
    role: "resp",
    ckInit: toBase64(chains.ckInit),
    ckResp: toBase64(chains.ckResp),
    sendCtr: 0,
    peerMaxCtr: -1,
    createdAt: Date.now(),
  };
}

// ── Chain ratchet ─────────────────────────────────────────────────────────────

export interface MessageKey {
  key: Uint8Array; // 32B AES key
  iv: Uint8Array; // 12B GCM nonce — derived, never transmitted
}

/**
 * Counter-addressed message key: iterate the chain n times, derive key+IV.
 * O(n) from the stored root; ROTATE_AFTER_MESSAGES caps n. Callers cache
 * advanced positions in memory (E2EEService) for O(1) sequential access.
 */
export function messageKeyAt(chainRoot: Uint8Array, n: number): MessageKey {
  let ck = chainRoot;
  for (let i = 0; i < n; i++) {
    ck = hmacSha256(ck, CHAIN_STEP);
  }
  const okm = hkdfSha256(ck, undefined, "msg", 44);
  return { key: okm.slice(0, 32), iv: okm.slice(32, 44) };
}

/** The chain this side ENCRYPTS with. */
export function sendChainRoot(session: StoredSession): Uint8Array {
  return fromBase64(session.role === "init" ? session.ckInit : session.ckResp);
}

/** The chain the PEER encrypts with (this side decrypts). */
export function receiveChainRoot(session: StoredSession): Uint8Array {
  return fromBase64(session.role === "init" ? session.ckResp : session.ckInit);
}

export function needsRotation(session: StoredSession): boolean {
  return (
    session.sendCtr >= ROTATE_AFTER_MESSAGES ||
    Date.now() - session.createdAt >= ROTATE_AFTER_MS
  );
}
