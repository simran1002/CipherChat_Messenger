/**
 * IndexedDB home of the encrypted search snapshots. Its own database ("CipherChatSearch") so a
 * schema change here can never touch key material or the offline queue. Usable from the search
 * worker: CryptoKey objects survive structured clone, and workers share the origin's IndexedDB.
 */
import { generateSnapshotKey, openSnapshot, sealSnapshot, type SealedSnapshot } from "./snapshotCrypto";
import type { SearchDoc } from "./searchCore";

const DB_NAME = "CipherChatSearch";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
      if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", { keyPath: "convId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = op(db.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      })
  );
}

let keyPromise: Promise<CryptoKey> | null = null;

function snapshotKey(): Promise<CryptoKey> {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    const existing = await run<{ id: string; key: CryptoKey } | undefined>("meta", "readonly", (s) => s.get("snapshotKey"));
    if (existing?.key) return existing.key;
    const key = await generateSnapshotKey();
    await run("meta", "readwrite", (s) => s.put({ id: "snapshotKey", key }));
    return key;
  })();
  return keyPromise;
}

export async function saveSnapshot(convId: string, docs: SearchDoc[]): Promise<void> {
  if (docs.length === 0) {
    await deleteSnapshot(convId);
    return;
  }
  const sealed = await sealSnapshot(await snapshotKey(), convId, docs);
  await run("snapshots", "readwrite", (s) => s.put(sealed));
}

export async function loadAllSnapshots(): Promise<SearchDoc[]> {
  const rows = await run<SealedSnapshot[]>("snapshots", "readonly", (s) => s.getAll());
  const key = await snapshotKey();
  const out: SearchDoc[] = [];
  for (const row of rows ?? []) {
    try {
      out.push(...(await openSnapshot(key, row)));
    } catch {
      // A blob that no longer opens (key reset, corruption) is dropped; the index rebuilds as
      // conversations are opened and decrypted again.
      await deleteSnapshot(row.convId);
    }
  }
  return out;
}

export function deleteSnapshot(convId: string): Promise<void> {
  return run("snapshots", "readwrite", (s) => s.delete(convId));
}

/** Logout / identity reset: remove every snapshot AND the key, so old blobs are unrecoverable. */
export async function wipeSearchStore(): Promise<void> {
  await run("snapshots", "readwrite", (s) => s.clear());
  await run("meta", "readwrite", (s) => s.clear());
  keyPromise = null;
}
