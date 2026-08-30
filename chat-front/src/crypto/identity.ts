/**
 * Identity lifecycle: generation, publication to the server key directory,
 * and the recovery-code backup that survives cleared browser storage.
 */
import api from "../services/api";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  fromBase64,
  generateEd25519,
  generateX25519,
  randomBytes,
  sign,
  toBase64,
  utf8Decode,
  utf8Encode,
} from "./primitives";
import {
  allSessions,
  loadBackupKeyMaterial,
  loadIdentity,
  saveBackupKeyMaterial,
  saveIdentity,
  saveSession,
  type StoredIdentity,
  type StoredSession,
} from "./keyStore";

// ── Generation + publication ─────────────────────────────────────────────────

export function generateIdentity(): StoredIdentity {
  const ed = generateEd25519();
  const x = generateX25519();
  const spk = generateX25519();
  return {
    edPriv: toBase64(ed.privateKey),
    edPub: toBase64(ed.publicKey),
    xPriv: toBase64(x.privateKey),
    xPub: toBase64(x.publicKey),
    spkId: 1,
    spkPriv: toBase64(spk.privateKey),
    spkPub: toBase64(spk.publicKey),
    createdAt: Date.now(),
  };
}

/** PUT the public bundle to the directory (server verifies the prekey sig). */
export async function publishIdentity(identity: StoredIdentity): Promise<void> {
  const sig = sign(fromBase64(identity.edPriv), fromBase64(identity.spkPub));
  await api.put("/keys", {
    identityEd25519: identity.edPub,
    identityX25519: identity.xPub,
    signedPreKey: { keyId: identity.spkId, pubX25519: identity.spkPub, sig: toBase64(sig) },
  });
}

/** Generate + persist + publish in one step. Returns the new identity. */
export async function createAndPublishIdentity(): Promise<StoredIdentity> {
  const identity = generateIdentity();
  await saveIdentity(identity);
  await publishIdentity(identity);
  return identity;
}

// ── Recovery-code backup ─────────────────────────────────────────────────────
//
// Code format: 8 groups of 4 crockford-base32 chars (128 bits), e.g.
// "K7PW-9XQ2-....". PBKDF2-SHA256 (600k iterations, WebCrypto) stretches it
// into the backup wrapping key. The blob stored server-side is opaque:
// salt || iv || AES-GCM(identity + sessions).

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // crockford — no I/L/O/U
const PBKDF2_ITERATIONS = 600_000;

export function generateRecoveryCode(): string {
  const bytes = randomBytes(20); // 160 bits → 32 chars
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  out = out.slice(0, 32);
  return out.match(/.{4}/g)!.join("-");
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

async function deriveBackupKey(code: string, salt: Uint8Array): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    utf8Encode(normalizeCode(code)) as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    material,
    256
  );
  return new Uint8Array(bits);
}

interface BackupPayload {
  identity: StoredIdentity;
  sessions: StoredSession[];
  exportedAt: number;
}

/** Seal identity + all sessions under the given key material and PUT the blob. */
async function encryptAndUpload(salt: Uint8Array, key: Uint8Array): Promise<void> {
  const identity = await loadIdentity();
  if (!identity) throw new Error("No identity to back up");
  const sessions = await allSessions();

  const iv = randomBytes(12);
  const payload: BackupPayload = { identity, sessions, exportedAt: Date.now() };
  const ct = aesGcmEncrypt(key, iv, utf8Encode(JSON.stringify(payload)));

  const blob = new Uint8Array(16 + 12 + ct.length);
  blob.set(salt);
  blob.set(iv, 16);
  blob.set(ct, 28);
  await api.put("/keys/backup/blob", { blob: toBase64(blob) });
}

/** Encrypt identity + sessions under the recovery code and upload the blob. */
export async function uploadBackup(code: string): Promise<void> {
  const salt = randomBytes(16);
  const key = await deriveBackupKey(code, salt);
  await encryptAndUpload(salt, key);
  // Keep the DERIVED key (never the code) so refreshBackup() can re-seal
  // later without prompting — the code itself is shown once and never stored.
  await saveBackupKeyMaterial({ salt: toBase64(salt), key: toBase64(key) });
}

/**
 * Re-upload the backup with the CURRENT session set, reusing the stored key
 * material — the user's existing recovery code keeps working. Called whenever
 * a session is created or rotated: sessions store chain key #0 (counters are
 * derived, never advanced away), so capturing a session once at birth is
 * enough to decrypt its entire lifetime after a restore. Without this, any
 * conversation started after setup was unrecoverable on a new device.
 * No-op (returns false) when no key material exists locally.
 */
export async function refreshBackup(): Promise<boolean> {
  const material = await loadBackupKeyMaterial();
  if (!material) return false;
  await encryptAndUpload(fromBase64(material.salt), fromBase64(material.key));
  return true;
}

/** Download + decrypt the backup; restores identity and session records. */
export async function restoreFromBackup(code: string): Promise<StoredIdentity> {
  const res = await api.get<{ blob: string }>("/keys/backup/blob");
  const blob = fromBase64(res.data.blob);
  const salt = blob.slice(0, 16);
  const iv = blob.slice(16, 28);
  const ct = blob.slice(28);

  const key = await deriveBackupKey(code, salt);
  let payload: BackupPayload;
  try {
    payload = JSON.parse(utf8Decode(aesGcmDecrypt(key, iv, ct))) as BackupPayload;
  } catch {
    throw new Error("Recovery code incorrect or backup corrupted");
  }

  await saveIdentity(payload.identity);
  for (const session of payload.sessions) {
    await saveSession(session);
  }
  // The restored device becomes a full citizen: it must be able to keep the
  // backup fresh as its own new sessions are established.
  await saveBackupKeyMaterial({ salt: toBase64(salt), key: toBase64(key) });
  return payload.identity;
}
