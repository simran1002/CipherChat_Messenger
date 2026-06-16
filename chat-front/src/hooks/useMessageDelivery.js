/**
 * At-least-once delivery with exponential backoff retry.
 *
 * Usage:
 *   const { send, pendingCount } = useMessageDelivery(socket, chatroomId);
 *   await send({ message, replyTo, expiresIn, clientMessageId });
 *
 * The hook retries up to MAX_RETRIES times if no ACK is received.
 * Once ACKed it removes the message from the pending set.
 * If offline, it falls back to OfflineQueue.enqueue().
 */

import { useState, useRef, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import { enqueue } from "../services/OfflineQueue";

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1_000;

function jitter(ms) {
  return ms + Math.random() * ms * 0.2;
}

export function useMessageDelivery(socket, chatroomId) {
  const [pendingCount, setPendingCount] = useState(0);
  const pendingRef = useRef(new Map()); // clientMessageId → { retries, timeoutId }

  const removePending = useCallback((id) => {
    const pending = pendingRef.current;
    if (!pending.has(id)) return;
    clearTimeout(pending.get(id).timeoutId);
    pending.delete(id);
    setPendingCount(pending.size);
  }, []);

  const send = useCallback(async (data) => {
    const clientMessageId = data.clientMessageId || uuidv4();
    const payload = { ...data, chatroomId, clientMessageId };

    // If socket is offline, persist to IndexedDB and bail
    if (!socket?.connected) {
      await enqueue(payload);
      return { queued: true, clientMessageId };
    }

    return new Promise((resolve) => {
      let retries = 0;

      const attempt = () => {
        socket.emit("chatroomMessage", payload, (ack) => {
          if (ack?.ok) {
            removePending(clientMessageId);
            resolve({ ok: true, messageId: ack.messageId, clientMessageId });
          } else if (ack?.error === "rate_limited") {
            removePending(clientMessageId);
            resolve({ ok: false, error: "rate_limited" });
          } else if (retries < MAX_RETRIES) {
            retries++;
            const delay = jitter(BASE_DELAY_MS * Math.pow(2, retries - 1));
            const timeoutId = setTimeout(attempt, delay);
            pendingRef.current.set(clientMessageId, { retries, timeoutId });
          } else {
            // Exhausted retries — queue for next reconnect
            enqueue(payload).then(() => {
              removePending(clientMessageId);
              resolve({ ok: false, queued: true, clientMessageId });
            });
          }
        });
      };

      // Register as pending before first attempt
      pendingRef.current.set(clientMessageId, { retries: 0, timeoutId: null });
      setPendingCount(pendingRef.current.size);
      attempt();
    });
  }, [socket, chatroomId, removePending]);

  return { send, pendingCount };
}
