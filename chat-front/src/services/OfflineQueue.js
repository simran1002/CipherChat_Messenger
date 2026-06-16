/**
 * IndexedDB-backed offline message queue.
 *
 * Messages typed while offline are queued here.
 * On reconnect, ChatroomPage calls OfflineQueue.drain(socket) which
 * emits `syncOfflineQueue` and removes confirmed items.
 *
 * Schema: { id (autoIncrement), clientMessageId, chatroomId, message, queuedAt }
 */

const DB_NAME = "CipherChat";
const DB_VERSION = 1;
const STORE = "offlineQueue";

let _db = null;

function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function enqueue(item) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).add({ ...item, queuedAt: Date.now() });
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function remove(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function clear() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).clear();
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Drain the queue through the socket.
 * Resolves once the server ACKs all items (or times out after 10s).
 */
export async function drain(socket) {
  const items = await getAll();
  if (!items.length) return;

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 10_000);

    socket.emit("syncOfflineQueue", { messages: items }, async () => {
      clearTimeout(timeout);
      await clear();
      resolve();
    });

    // Fallback: listen for result event (server may not ack cb in all versions)
    socket.once("syncOfflineQueueResult", async ({ results }) => {
      clearTimeout(timeout);
      for (const item of items) {
        const r = results.find((x) => x.clientMessageId === item.clientMessageId);
        if (r?.ok || r?.duplicate) await remove(item.id).catch(() => {});
      }
      resolve();
    });
  });
}
