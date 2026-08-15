/**
 * IndexedDB-backed offline message queue.
 *
 * Messages typed while offline are queued here.
 * On reconnect, ChatroomPage calls drain(socket) which emits
 * `syncOfflineQueue` and removes confirmed items.
 *
 * Schema: { id (autoIncrement), clientMessageId, chatroomId, message, queuedAt }
 */
import type { AppSocket } from "../types";

const DB_NAME = "CipherChat";
const DB_VERSION = 1;
const STORE = "offlineQueue";

export interface QueuedMessage {
  id?: number;
  clientMessageId?: string;
  chatroomId: string;
  message: string;
  replyTo?: unknown;
  expiresIn?: number;
  queuedAt?: number;
}

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function enqueue(item: QueuedMessage): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).add({ ...item, queuedAt: Date.now() });
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(): Promise<QueuedMessage[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as QueuedMessage[]);
    req.onerror = () => reject(req.error);
  });
}

export async function remove(id: number): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function clear(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Drain the queue through the socket.
 * Resolves once the server confirms the items (or after a 10s timeout).
 *
 * Items are removed selectively by the server's per-item results — the old
 * implementation cleared the whole store on ack, which could drop messages
 * enqueued while the drain was in flight.
 */
export async function drain(socket: AppSocket): Promise<void> {
  const items = await getAll();
  if (!items.length) return;

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        socket.off("syncOfflineQueueResult", onResult);
        resolve();
      }
    };
    const timeout = setTimeout(finish, 10_000);

    const onResult = async ({ results }: { results: Array<{ clientMessageId?: string; ok?: boolean; duplicate?: boolean }> }) => {
      clearTimeout(timeout);
      for (const item of items) {
        const r = results.find((x) => x.clientMessageId === item.clientMessageId);
        if ((r?.ok || r?.duplicate) && item.id !== undefined) {
          await remove(item.id).catch(() => {});
        }
      }
      finish();
    };

    socket.once("syncOfflineQueueResult", onResult);
    socket.emit("syncOfflineQueue", {
      messages: items.map((i) => ({
        chatroomId: i.chatroomId,
        message: i.message,
        clientMessageId: i.clientMessageId,
      })),
    });
  });
}
