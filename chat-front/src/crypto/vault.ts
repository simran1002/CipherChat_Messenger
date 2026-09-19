/**
 * The conversation vault — what makes per-message key deletion and cryptographic shredding possible.
 *
 * With the Double Ratchet a message key is destroyed the moment it is used, so the ciphertext the
 * server stores can never be opened again — not by an attacker who seizes the device later, and not
 * by us. History therefore has to live on the device, and it lives here, encrypted:
 *
 *   deks      { convId, key: CryptoKey }        one non-extractable AES-256-GCM key per conversation
 *   ratchets  { sessionId, convId, iv, blob }   ratchet state, sealed under the conversation's key
 *   messages  { id, convId, iv, blob }          decrypted plaintext, sealed under the conversation's key
 *
 * Cryptographic shredding = deleting one `deks` row. Everything sealed under it (history AND the
 * ratchet) becomes unrecoverable at once, even if the blobs linger on disk, because the key never
 * existed in script-readable form. The rows are deleted too; the key deletion is the guarantee.
 *
 * commit() writes the advanced ratchet and the plaintext it just produced in ONE IndexedDB
 * transaction. That atomicity is load-bearing: a ratchet that advanced without its plaintext being
 * saved would have destroyed the only key to a message nobody had stored.
 */
import type { RatchetState } from "./doubleRatchet";

const DB_NAME = "CipherChatVault";
const DB_VERSION = 1;

export interface RatchetSession {
  sessionId: string;
  conversationId: string;
  peerId: string;
  role: "init" | "resp";
  createdAt: number;
  /** Monotonic count of everything THIS side has sent on the session — the server's replay counter. */
  sendTotal: number;
  /** Initiator only: the peer has answered, so the X3DH init block can stop riding along. */
  peerReplied: boolean;
  init?: { ephPub: string; ik: string; spkId: number };
  state: RatchetState;
}

interface SealedRow {
  iv: Uint8Array;
  blob: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── pure crypto (unit-tested without IndexedDB) ───────────────────────────────

export function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function sealRecord(key: CryptoKey, label: string, value: unknown): Promise<SealedRow> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const blob = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(label) }, key, enc.encode(JSON.stringify(value)))
  );
  return { iv, blob };
}

/** Throws when the row was tampered with or is opened under a different label (row swapped). */
export async function openRecord<T>(key: CryptoKey, label: string, row: SealedRow): Promise<T> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: row.iv as BufferSource, additionalData: enc.encode(label) },
    key,
    row.blob as BufferSource
  );
  return JSON.parse(dec.decode(pt)) as T;
}

export function messageKey(sessionId: string, senderId: string, ctr: number): string {
  return `${sessionId}|${senderId}|${ctr}`;
}

// ── IndexedDB ─────────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("deks")) db.createObjectStore("deks", { keyPath: "convId" });
      if (!db.objectStoreNames.contains("ratchets")) {
        db.createObjectStore("ratchets", { keyPath: "sessionId" }).createIndex("byConversation", "convId");
      }
      if (!db.objectStoreNames.contains("messages")) {
        db.createObjectStore("messages", { keyPath: "id" }).createIndex("byConversation", "convId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("vault transaction aborted"));
  });
}

async function dek(convId: string, create: boolean): Promise<CryptoKey | null> {
  const db = await openDb();
  const existing = await request<{ convId: string; key: CryptoKey } | undefined>(
    db.transaction("deks", "readonly").objectStore("deks").get(convId)
  );
  if (existing?.key) return existing.key;
  if (!create) return null;
  const key = await generateDek();
  const tx = db.transaction("deks", "readwrite");
  tx.objectStore("deks").add({ convId, key }); // add, not put: a racing tab must not replace a key already in use
  try {
    await done(tx);
    return key;
  } catch {
    return (await dek(convId, false)) ?? key;
  }
}

/** Persist an advanced ratchet and (optionally) the plaintext it produced — atomically. */
export async function commit(
  convId: string,
  session: RatchetSession,
  message?: { key: string; text: string }
): Promise<void> {
  const key = (await dek(convId, true))!;
  // All WebCrypto work happens BEFORE the transaction opens: IndexedDB auto-commits a transaction
  // as soon as control returns to the event loop without a pending request.
  const sealedSession = await sealRecord(key, `ratchet:${session.sessionId}`, session);
  const sealedMessage = message ? await sealRecord(key, `message:${convId}|${message.key}`, message.text) : null;

  const db = await openDb();
  const tx = db.transaction(["ratchets", "messages"], "readwrite");
  tx.objectStore("ratchets").put({ sessionId: session.sessionId, convId, ...sealedSession });
  if (message && sealedMessage) {
    tx.objectStore("messages").put({ id: `${convId}|${message.key}`, convId, ...sealedMessage });
  }
  await done(tx);
}

export async function loadRatchet(convId: string, sessionId: string): Promise<RatchetSession | null> {
  const key = await dek(convId, false);
  if (!key) return null;
  const db = await openDb();
  const row = await request<(SealedRow & { convId: string }) | undefined>(
    db.transaction("ratchets", "readonly").objectStore("ratchets").get(sessionId)
  );
  if (!row || row.convId !== convId) return null;
  return openRecord<RatchetSession>(key, `ratchet:${sessionId}`, row);
}

/** Newest ratchet session of a conversation, if any. */
export async function latestRatchet(convId: string): Promise<RatchetSession | null> {
  const key = await dek(convId, false);
  if (!key) return null;
  const db = await openDb();
  const rows = await request<(SealedRow & { sessionId: string })[]>(
    db.transaction("ratchets", "readonly").objectStore("ratchets").index("byConversation").getAll(convId)
  );
  const sessions: RatchetSession[] = [];
  for (const row of rows ?? []) {
    try {
      sessions.push(await openRecord<RatchetSession>(key, `ratchet:${row.sessionId}`, row));
    } catch {
      // unreadable under the current key: ignore, a new session will be negotiated
    }
  }
  return sessions.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

export async function loadMessage(convId: string, msgKey: string): Promise<string | null> {
  const key = await dek(convId, false);
  if (!key) return null;
  const db = await openDb();
  const row = await request<SealedRow | undefined>(
    db.transaction("messages", "readonly").objectStore("messages").get(`${convId}|${msgKey}`)
  );
  if (!row) return null;
  try {
    return await openRecord<string>(key, `message:${convId}|${msgKey}`, row);
  } catch {
    return null;
  }
}

/**
 * Cryptographic shredding of one conversation on this device: the key goes first (that is the
 * guarantee), then the sealed rows (hygiene). Returns how many sealed rows were removed.
 */
export async function shredConversation(convId: string): Promise<number> {
  const db = await openDb();
  const tx = db.transaction(["deks", "ratchets", "messages"], "readwrite");
  tx.objectStore("deks").delete(convId);
  let removed = 0;
  for (const store of ["ratchets", "messages"] as const) {
    const cursorReq = tx.objectStore(store).index("byConversation").openKeyCursor(IDBKeyRange.only(convId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      tx.objectStore(store).delete(cursor.primaryKey);
      removed++;
      cursor.continue();
    };
  }
  await done(tx);
  return removed;
}

export async function hasVault(convId: string): Promise<boolean> {
  return (await dek(convId, false)) !== null;
}

/** Identity reset / logout-everywhere: every conversation key and every sealed row. */
export async function wipeVault(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["deks", "ratchets", "messages"], "readwrite");
  tx.objectStore("deks").clear();
  tx.objectStore("ratchets").clear();
  tx.objectStore("messages").clear();
  await done(tx);
}
