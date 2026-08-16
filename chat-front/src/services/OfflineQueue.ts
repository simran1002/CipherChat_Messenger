/**
 * IndexedDB-backed offline message queue — v2.
 *
 * v1 stored only chatroom sends. v2 generalizes to `{kind, targetId, payload}`
 * so DM sends can queue too. For DMs, `payload` already holds a sealed E2EE
 * envelope by the time it reaches enqueue() — encryption happens BEFORE
 * queueing (E2EEService.encrypt reserves the ratchet counter and persists it
 * first), so nothing here ever stores DM plaintext. Because decryption is
 * counter-addressed, a queued ciphertext decrypts correctly regardless of
 * when it eventually drains relative to other messages.
 *
 * v1 → v2 upgrade migrates existing rows to
 * `{kind:"chatroom", targetId: chatroomId, payload:{message,replyTo,expiresIn}}`.
 */
import type { AppSocket, DirectMessagePayload, DmMessageAck } from "../types";

const DB_NAME = "CipherChat";
const DB_VERSION = 2;
const STORE = "offlineQueue";

export type QueueKind = "chatroom" | "dm";

export interface ChatroomQueuePayload {
  message: string;
  replyTo?: unknown;
  expiresIn?: number;
}

export type DmQueuePayload = Pick<DirectMessagePayload, "message" | "envelope">;

export interface QueuedItem<K extends QueueKind = QueueKind> {
  id?: number;
  clientMessageId?: string;
  kind: K;
  /** chatroomId for "chatroom", conversationId for "dm". */
  targetId: string;
  payload: K extends "chatroom" ? ChatroomQueuePayload : DmQueuePayload;
  queuedAt?: number;
}

/** @deprecated v1 record shape, kept only for the upgrade migration. */
interface LegacyQueuedMessage {
  id: number;
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

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction!;

      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        return; // fresh install — nothing to migrate
      }

      if (event.oldVersion < 2) {
        const store = tx.objectStore(STORE);
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const legacy = cursor.value as LegacyQueuedMessage;
          // Already-migrated or unrecognized rows pass through untouched
          if (!("kind" in legacy)) {
            const migrated: QueuedItem<"chatroom"> = {
              id: legacy.id,
              clientMessageId: legacy.clientMessageId,
              kind: "chatroom",
              targetId: legacy.chatroomId,
              payload: { message: legacy.message, replyTo: legacy.replyTo, expiresIn: legacy.expiresIn },
              queuedAt: legacy.queuedAt,
            };
            cursor.update(migrated);
          }
          cursor.continue();
        };
      }
    };

    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function enqueue<K extends QueueKind>(item: Omit<QueuedItem<K>, "id" | "queuedAt">): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).add({ ...item, queuedAt: Date.now() });
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(): Promise<QueuedItem[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as QueuedItem[]);
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
 * Drain chatroom sends via the batch `syncOfflineQueue` event (unchanged
 * server-side contract). DM sends drain separately (drainDms) since the
 * server acks each `directMessage` individually rather than as a batch.
 *
 * Resolves once the server confirms the items (or after a 10s timeout).
 * Items are removed selectively by the server's per-item results — a blanket
 * clear() on ack could drop messages enqueued while the drain was in flight.
 */
export async function drain(socket: AppSocket): Promise<void> {
  const items = (await getAll()).filter((i): i is QueuedItem<"chatroom"> => i.kind === "chatroom");
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

    const onResult = async ({
      results,
    }: {
      results: Array<{ clientMessageId?: string; ok?: boolean; duplicate?: boolean }>;
    }) => {
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
        chatroomId: i.targetId,
        message: i.payload.message,
        clientMessageId: i.clientMessageId,
      })),
    });
  });
}

/**
 * Drain queued DM sends. Each is a pre-sealed envelope (or legacy plaintext
 * fallback) — this only replays the send, it never touches crypto state.
 * Sequential, not parallel: preserves send order within a conversation.
 */
export async function drainDms(
  socket: AppSocket,
  onAck?: (item: QueuedItem<"dm">, ack: DmMessageAck) => void
): Promise<void> {
  const items = (await getAll()).filter((i): i is QueuedItem<"dm"> => i.kind === "dm");

  for (const item of items) {
    const ack = await new Promise<DmMessageAck>((resolve) => {
      socket
        .timeout(8000)
        .emit(
          "directMessage",
          { conversationId: item.targetId, clientMessageId: item.clientMessageId, ...item.payload },
          (err: Error | null, response?: DmMessageAck) =>
            resolve(err || !response ? { ok: false, error: "server_error" } : response)
        );
    });

    onAck?.(item, ack);
    if ((ack.ok || ack.duplicate) && item.id !== undefined) {
      await remove(item.id).catch(() => {});
    }
  }
}
