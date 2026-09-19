/*
 * CipherChat service worker — background flush of the offline mutation queue.
 *
 * Scope is deliberately narrow: NO fetch handler and NO caching, so it can never serve a stale
 * app shell. Its one job: when connectivity returns and no tab is open to drain the queue itself,
 * send what the user wrote while offline.
 *
 * Why this is safe to run blind:
 *   - every queued item carries a clientMessageId, and the server's unique index makes a replay a
 *     no-op ("duplicate": true), so at-least-once flushing cannot double-post;
 *   - DM items are already sealed E2EE envelopes (encryption happens before enqueue), so the
 *     worker never sees DM plaintext or any key material;
 *   - it authenticates by rotating the httpOnly refresh cookie — it never reads a stored token;
 *   - if any window is open it stands down: the page drains over its live socket and gets ACKs.
 */
const DB_NAME = "CipherChat";
const STORE = "offlineQueue";
const SYNC_TAG = "cipherchat-outbox";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("sync", (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(flushOutbox());
});

// Pages post {type:"flush-outbox", apiBase} when they go offline→online in browsers without Background Sync.
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "config" && typeof data.apiBase === "string") apiBase = data.apiBase;
  if (data.type === "flush-outbox") event.waitUntil(flushOutbox());
});

let apiBase = "";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readAll(db) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE)) return resolve([]);
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function removeRow(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function accessToken() {
  const res = await fetch(`${apiBase}/api/v1/auth/refresh`, { method: "POST", credentials: "include" });
  if (!res.ok) throw new Error(`refresh ${res.status}`);
  const body = await res.json();
  return body.token || body.accessToken;
}

async function flushOutbox() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (windows.length > 0) return; // a page is open: it drains over its socket and sees the ACKs

  const db = await openDb();
  const items = (await readAll(db)).sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0));
  if (items.length === 0) return;

  const token = await accessToken(); // throws → the sync event is retried by the browser with backoff
  for (const item of items) {
    const url = item.kind === "dm"
      ? `${apiBase}/api/v1/conversations/${item.targetId}/messages`
      : `${apiBase}/api/v1/chatrooms/${item.targetId}/messages`;
    const body = item.kind === "dm"
      ? { clientMessageId: item.clientMessageId, message: item.payload.message, envelope: item.payload.envelope }
      : { clientMessageId: item.clientMessageId, message: item.payload.message, replyTo: item.payload.replyTo, expiresIn: item.payload.expiresIn };

    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

    if (res.ok || res.status === 409) {
      await removeRow(db, item.id);          // accepted, absorbed as a duplicate, or a spent E2EE counter
    } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      await removeRow(db, item.id);          // permanently rejected (room gone, access revoked): do not retry forever
    } else {
      throw new Error(`flush ${res.status}`); // 429/5xx/network: keep the rest, let the browser retry the sync
    }
  }
}
