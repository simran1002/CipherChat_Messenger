/**
 * At-least-once delivery with exponential backoff retry.
 *
 * Usage:
 *   const { send, pendingCount } = useMessageDelivery(socket, chatroomId);
 *   await send({ message, replyTo, expiresIn, clientMessageId });
 *
 * The hook retries up to MAX_RETRIES times if no ACK is received within the
 * per-attempt timeout (the old version waited on an ack callback that never
 * fires when the packet is lost — socket.timeout() fixes that). Once ACKed it
 * removes the message from the pending set. If offline, it falls back to
 * OfflineQueue.enqueue().
 */
import { useState, useRef, useCallback } from "react";
import { enqueue } from "../services/OfflineQueue";
import type { AppSocket, MessageAck, ReplyToRef } from "../types";

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1_000;
const ACK_TIMEOUT_MS = 5_000;

function jitter(ms: number): number {
  return ms + Math.random() * ms * 0.2;
}

export interface SendInput {
  message: string;
  replyTo?: ReplyToRef;
  expiresIn?: number;
  clientMessageId?: string;
  /** User ids selected via the composer's @mention autocomplete (max 10). */
  mentions?: string[];
}

export type SendResult =
  | { ok: true; messageId?: string; clientMessageId: string }
  | { ok: false; error: "rate_limited" | "invalid_message" | "forbidden" | "server_error" }
  | { ok?: false; queued: true; clientMessageId: string };

/** Ack errors that must never be retried — the server's answer won't change. */
const TERMINAL_ACK_ERRORS = ["rate_limited", "invalid_message", "forbidden"] as const;
type TerminalAckError = (typeof TERMINAL_ACK_ERRORS)[number];

function terminalAckError(ack: MessageAck | undefined): TerminalAckError | null {
  if (!ack || ack.ok || !ack.error) return null;
  return (TERMINAL_ACK_ERRORS as readonly string[]).includes(ack.error)
    ? (ack.error as TerminalAckError)
    : null;
}

export function useMessageDelivery(socket: AppSocket | null, chatroomId: string | undefined) {
  const [pendingCount, setPendingCount] = useState(0);
  const pendingRef = useRef(new Map<string, { retries: number; timeoutId: ReturnType<typeof setTimeout> | null }>());

  const removePending = useCallback((id: string) => {
    const pending = pendingRef.current;
    const entry = pending.get(id);
    if (!entry) return;
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    pending.delete(id);
    setPendingCount(pending.size);
  }, []);

  const send = useCallback(
    async (data: SendInput): Promise<SendResult> => {
      if (!chatroomId) return { ok: false, error: "invalid_message" };
      const clientMessageId = data.clientMessageId || crypto.randomUUID();
      const payload = { ...data, chatroomId, clientMessageId };

      // If socket is offline, persist to IndexedDB and bail
      if (!socket?.connected) {
        await enqueue({
          clientMessageId,
          kind: "chatroom",
          targetId: chatroomId,
          payload: { message: data.message, replyTo: data.replyTo, expiresIn: data.expiresIn },
        });
        return { queued: true, clientMessageId };
      }

      return new Promise((resolve) => {
        let retries = 0;

        const attempt = () => {
          socket
            .timeout(ACK_TIMEOUT_MS)
            .emit("chatroomMessage", payload, (err: Error | null, ack?: MessageAck) => {
              const terminal = err ? null : terminalAckError(ack);
              if (!err && ack?.ok) {
                removePending(clientMessageId);
                resolve({ ok: true, messageId: ack.messageId, clientMessageId });
              } else if (terminal) {
                // rate_limited / invalid_message / forbidden — retrying can't
                // succeed, so surface the error immediately. Only timeouts
                // (err from socket.timeout) and server_error acks retry.
                removePending(clientMessageId);
                resolve({ ok: false, error: terminal });
              } else if (retries < MAX_RETRIES) {
                retries++;
                const delay = jitter(BASE_DELAY_MS * Math.pow(2, retries - 1));
                const timeoutId = setTimeout(attempt, delay);
                pendingRef.current.set(clientMessageId, { retries, timeoutId });
              } else {
                // Exhausted retries — queue for next reconnect
                void enqueue({
                  clientMessageId,
                  kind: "chatroom",
                  targetId: chatroomId,
                  payload: { message: data.message, replyTo: data.replyTo, expiresIn: data.expiresIn },
                }).then(() => {
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
    },
    [socket, chatroomId, removePending]
  );

  return { send, pendingCount };
}
