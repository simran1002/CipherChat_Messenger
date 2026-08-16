/**
 * Encrypted-at-rest key storage.
 *
 * Separate IndexedDB database ("CipherChatKeys") from the offline queue — a
 * queue schema bump must never risk key material. Layout:
 *
 *   meta      { id: "wrappingKey", key: CryptoKey }   non-extractable AES-256-GCM
 *   identity  { id: "identity", wrapped: b64 }        noble keys wrapped under it
 *   sessions  { sessionId, conversationId, wrapped }  chain keys wrapped under it
 *   peers     { userId, identityEd25519, keyVersion, verified }  TOFU pins
 *   previews  { conversationId, wrapped }             encrypted preview cache
 *
 * The wrapping key is a WebCrypto non-extractable CryptoKey (structured-clone
 * persisted): even with full IndexedDB read access, key bytes never exist in
 * script-readable form at rest. The noble private keys do exist in memory
 * while the tab runs — inherent to web E2EE, stated in the threat model.
 */
import { fromBase64, toBase64, utf8Decode, utf8Encode } from "./primitives";

const DB_NAME = "CipherChatKeys";
const DB_VERSION = 1;

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
      if (!db.objectStoreNames.contains("identity")) db.createObjectStore("identity", { keyPath: "id" });
      if (!db.objectStoreNames.contains("sessions")) {
        const s = db.createObjectStore("sessions", { keyPath: "sessionId" });
        s.createIndex("byConversation", "conversationId");
      }
      if (!db.objectStoreNames.contains("peers")) db.createObjectStore("peers", { keyPath: "userId" });
      if (!db.objectStoreNames.contains("previews"))
        db.createObjectStore("previews", { keyPath: "conversationId" });
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = op(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      })
  );
}

// ── Non-extractable wrapping key ─────────────────────────────────────────────

async function getWrappingKey(): Promise<CryptoKey> {
  const existing = await tx<{ id: string; key: CryptoKey } | undefined>("meta", "readonly", (s) =>
    s.get("wrappingKey")
  );
  if (existing?.key) return existing.key;

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await tx("meta", "readwrite", (s) => s.put({ id: "wrappingKey", key }));
  return key;
}

export async function wrapJson(value: unknown): Promise<string> {
  const key = await getWrappingKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = utf8Encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt as BufferSource));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return toBase64(out);
}

export async function unwrapJson<T>(wrapped: string): Promise<T> {
  const key = await getWrappingKey();
  const bytes = fromBase64(wrapped);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ct as BufferSource)
  );
  return JSON.parse(utf8Decode(pt)) as T;
}

// ── Identity ─────────────────────────────────────────────────────────────────

export interface StoredIdentity {
  edPriv: string; // b64
  edPub: string;
  xPriv: string;
  xPub: string;
  spkId: number;
  spkPriv: string;
  spkPub: string;
  createdAt: number;
}

export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  const wrapped = await wrapJson(identity);
  await tx("identity", "readwrite", (s) => s.put({ id: "identity", wrapped }));
}

export async function loadIdentity(): Promise<StoredIdentity | null> {
  const row = await tx<{ id: string; wrapped: string } | undefined>("identity", "readonly", (s) =>
    s.get("identity")
  );
  if (!row) return null;
  return unwrapJson<StoredIdentity>(row.wrapped);
}

export async function deleteIdentity(): Promise<void> {
  await tx("identity", "readwrite", (s) => s.delete("identity"));
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export interface StoredSession {
  sessionId: string;
  conversationId: string;
  peerId: string;
  role: "init" | "resp";
  ckInit: string; // b64 chain key #0, init→resp direction
  ckResp: string; // b64 chain key #0, resp→init direction
  sendCtr: number; // next counter THIS side will use
  peerMaxCtr: number; // highest peer counter seen (replay floor)
  createdAt: number;
  retiredAt?: number;
}

interface SessionRow {
  sessionId: string;
  conversationId: string;
  wrapped: string;
}

export async function saveSession(session: StoredSession): Promise<void> {
  const wrapped = await wrapJson(session);
  await tx("sessions", "readwrite", (s) =>
    s.put({ sessionId: session.sessionId, conversationId: session.conversationId, wrapped })
  );
}

export async function loadSession(sessionId: string): Promise<StoredSession | null> {
  const row = await tx<SessionRow | undefined>("sessions", "readonly", (s) => s.get(sessionId));
  return row ? unwrapJson<StoredSession>(row.wrapped) : null;
}

export async function loadConversationSessions(conversationId: string): Promise<StoredSession[]> {
  const rows = await openDb().then(
    (db) =>
      new Promise<SessionRow[]>((resolve, reject) => {
        const t = db.transaction("sessions", "readonly");
        const req = t.objectStore("sessions").index("byConversation").getAll(conversationId);
        req.onsuccess = () => resolve(req.result as SessionRow[]);
        req.onerror = () => reject(req.error);
      })
  );
  return Promise.all(rows.map((r) => unwrapJson<StoredSession>(r.wrapped)));
}

export async function allSessions(): Promise<StoredSession[]> {
  const rows = await tx<SessionRow[]>("sessions", "readonly", (s) => s.getAll());
  return Promise.all(rows.map((r) => unwrapJson<StoredSession>(r.wrapped)));
}

// ── Peer identity pins (TOFU) ────────────────────────────────────────────────

export interface PeerPin {
  userId: string;
  identityEd25519: string;
  keyVersion: number;
  verified: boolean; // user compared safety numbers
  pinnedAt: number;
}

export async function getPeerPin(userId: string): Promise<PeerPin | null> {
  const row = await tx<PeerPin | undefined>("peers", "readonly", (s) => s.get(userId));
  return row ?? null;
}

export async function savePeerPin(pin: PeerPin): Promise<void> {
  await tx("peers", "readwrite", (s) => s.put(pin));
}

// ── Preview cache (encrypted) ────────────────────────────────────────────────

export interface CachedPreview {
  text: string;
  at: number;
}

export async function savePreview(conversationId: string, preview: CachedPreview): Promise<void> {
  const wrapped = await wrapJson(preview);
  await tx("previews", "readwrite", (s) => s.put({ conversationId, wrapped }));
}

export async function loadPreview(conversationId: string): Promise<CachedPreview | null> {
  const row = await tx<{ conversationId: string; wrapped: string } | undefined>(
    "previews",
    "readonly",
    (s) => s.get(conversationId)
  );
  return row ? unwrapJson<CachedPreview>(row.wrapped) : null;
}

// ── Reset ────────────────────────────────────────────────────────────────────

/** Wipe everything (encryption reset / logout of the only account). */
export async function wipeKeyStore(): Promise<void> {
  const db = await openDb();
  await Promise.all(
    ["meta", "identity", "sessions", "peers", "previews"].map(
      (store) =>
        new Promise<void>((resolve, reject) => {
          const t = db.transaction(store, "readwrite");
          const req = t.objectStore(store).clear();
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        })
    )
  );
}

// ── Cross-tab mutual exclusion ───────────────────────────────────────────────

/**
 * Serialize ratchet-advancing operations across tabs. Web Locks where
 * available; a per-page promise queue otherwise (single-tab correctness).
 */
const fallbackQueues = new Map<string, Promise<unknown>>();

export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    return navigator.locks.request(`e2ee:${name}`, fn) as Promise<T>;
  }
  const prev = fallbackQueues.get(name) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  fallbackQueues.set(
    name,
    next.catch(() => {})
  );
  return next;
}
