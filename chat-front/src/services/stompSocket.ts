/**
 * STOMP transport behind the app's socket interface.
 *
 * The pages and hooks were written against a Socket.IO-style API
 * (`emit` / `on` / `off` / `once` / `timeout().emit`). The Java backend speaks
 * STOMP over a raw WebSocket (`/ws`), so this module is the ONE place that
 * knows both vocabularies:
 *
 *   emit("chatroomMessage", p, ack)  →  SEND /app/rooms/send   … ack ← /user/queue/acks (by clientMessageId)
 *   emit("joinRoom", {chatroomId})   →  SUBSCRIBE /topic/rooms/{id}
 *   on("newMessage", h)              ←  frames {event, payload} on the subscribed topics
 *
 * Reconnects re-subscribe every room/DM the page had joined, and the CONNECT
 * frame re-reads the access token from storage each attempt so a token
 * rotated by the silent-refresh interceptor is picked up automatically.
 */
import { Client, type IFrame, type IMessage, type StompSubscription } from "@stomp/stompjs";
import api from "./api";
import type {
  ChatroomFileMessagePayload,
  ClientToServerEvents,
  DmMessageAck,
  MessageAck,
  ServerToClientEvents,
} from "../types/socket";

type LifecycleEvents = {
  connect: () => void;
  disconnect: (reason: string) => void;
  connect_error: (err: Error) => void;
};
type Incoming = ServerToClientEvents & LifecycleEvents;
type Handler = (...args: never[]) => void;

interface ServerFrame {
  event: string;
  payload: unknown;
}

/** Wire shape of /user/queue/acks — one record for room and DM sends. */
interface WireAck {
  ok: boolean;
  messageId?: string | null;
  sequenceNumber?: number | null;
  duplicate?: boolean;
  error?: string | null;
  clientMessageId?: string | null;
}

export interface AppSocket {
  readonly connected: boolean;
  readonly id: string;
  connect(): void;
  disconnect(): void;
  on<E extends keyof Incoming>(event: E, handler: Incoming[E]): this;
  once<E extends keyof Incoming>(event: E, handler: Incoming[E]): this;
  off<E extends keyof Incoming>(event: E, handler?: Incoming[E]): this;
  emit<E extends keyof ClientToServerEvents>(event: E, ...args: Parameters<ClientToServerEvents[E]>): this;
  /** Socket.IO-compatible: the callback receives (err, ack) and `err` is set when no ACK arrives in time. */
  timeout(ms: number): {
    emit<E extends "chatroomMessage" | "directMessage">(
      event: E,
      payload: Parameters<ClientToServerEvents[E]>[0],
      cb: (err: Error | null, ack?: E extends "chatroomMessage" ? MessageAck : DmMessageAck) => void
    ): void;
  };
}

const HEARTBEAT_MS = 25_000;

export function toWebSocketUrl(origin: string): string {
  const base = origin || window.location.origin;
  return base.replace(/^http/, "ws").replace(/\/+$/, "") + "/ws";
}

export function createStompSocket(origin: string): AppSocket {
  const listeners = new Map<string, Set<Handler>>();
  const rooms = new Map<string, StompSubscription>();
  const dms = new Map<string, StompSubscription>();
  const pendingAcks = new Map<string, { cb: (ack: WireAck) => void; timer: ReturnType<typeof setTimeout> | null }>();
  let syncAck: (() => void) | null = null;
  const id = crypto.randomUUID();

  const client = new Client({
    brokerURL: toWebSocketUrl(origin),
    heartbeatIncoming: HEARTBEAT_MS,
    heartbeatOutgoing: HEARTBEAT_MS,
    reconnectDelay: 3_000,
    beforeConnect: () => {
      client.connectHeaders = { Authorization: `Bearer ${localStorage.getItem("CC_Token") ?? ""}` };
    },
  });

  // ── dispatch ─────────────────────────────────────────────────────────────

  function dispatch(event: string, ...args: unknown[]): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const h of Array.from(set)) (h as (...a: unknown[]) => void)(...args);
  }

  function onServerFrame(msg: IMessage): void {
    try {
      const frame = JSON.parse(msg.body) as ServerFrame;
      if (frame && typeof frame.event === "string") dispatch(frame.event, frame.payload);
    } catch (e) {
      console.warn("Dropped malformed frame", e);
    }
  }

  function onAck(msg: IMessage): void {
    let ack: WireAck;
    try {
      ack = JSON.parse(msg.body) as WireAck;
    } catch {
      return;
    }
    const key = ack.clientMessageId ?? "";
    const pending = pendingAcks.get(key);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pendingAcks.delete(key);
      pending.cb(ack);
    } else if (!ack.ok) {
      dispatch("messageError", { error: ack.error ?? undefined, message: ack.error ?? "Message rejected" });
    }
  }

  function onSyncResult(msg: IMessage): void {
    try {
      dispatch("syncOfflineQueueResult", JSON.parse(msg.body));
    } finally {
      const cb = syncAck;
      syncAck = null;
      cb?.();
    }
  }

  // ── subscriptions ────────────────────────────────────────────────────────

  function subscribeUserQueues(): void {
    // Not tracked for manual unsubscribe — stompjs tears every subscription
    // down itself on disconnect, and onConnect re-subscribes them fresh.
    client.subscribe("/user/queue/events", onServerFrame);
    client.subscribe("/user/queue/acks", onAck);
    client.subscribe("/user/queue/sync", onSyncResult);
    client.subscribe("/topic/presence", onServerFrame);
  }

  function subscribeRoom(roomId: string): void {
    if (!client.connected || rooms.has(roomId)) return;
    rooms.set(roomId, client.subscribe(`/topic/rooms/${roomId}`, onServerFrame));
  }

  function subscribeDm(conversationId: string): void {
    if (!client.connected || dms.has(conversationId)) return;
    dms.set(conversationId, client.subscribe(`/topic/dm/${conversationId}`, onServerFrame));
  }

  client.onConnect = () => {
    subscribeUserQueues();
    // Re-establish everything the pages had joined before the reconnect.
    for (const roomId of Array.from(rooms.keys())) {
      rooms.delete(roomId);
      subscribeRoom(roomId);
    }
    for (const conv of Array.from(dms.keys())) {
      dms.delete(conv);
      subscribeDm(conv);
    }
    dispatch("connect");
  };

  client.onWebSocketClose = (evt: CloseEvent) => {
    dispatch("disconnect", evt?.reason || "transport close");
  };

  client.onStompError = (frame: IFrame) => {
    const message = frame.headers["message"] ?? "STOMP error";
    // The server refuses the CONNECT frame with an ERROR when the token is bad/expired.
    const authFailure = /token|unauth|401|credential/i.test(message);
    dispatch("connect_error", new Error(authFailure ? "Invalid token" : message));
  };

  client.onWebSocketError = () => {
    dispatch("connect_error", new Error("websocket error"));
  };

  // ── publish helpers ──────────────────────────────────────────────────────

  function publish(destination: string, body: unknown): void {
    if (!client.connected) return;
    client.publish({ destination, body: JSON.stringify(body ?? {}) });
  }

  function sendWithAck(destination: string, payload: Record<string, unknown>, cb?: (ack: WireAck) => void, timeoutMs?: number): void {
    const clientMessageId = (payload.clientMessageId as string | undefined) ?? crypto.randomUUID();
    const body = { ...payload, clientMessageId };
    if (cb) {
      const timer = timeoutMs
        ? setTimeout(() => {
            pendingAcks.delete(clientMessageId);
            cb({ ok: false, error: "timeout", clientMessageId });
          }, timeoutMs)
        : null;
      pendingAcks.set(clientMessageId, { cb, timer });
    }
    publish(destination, body);
  }

  function toMessageAck(ack: WireAck): MessageAck {
    return {
      ok: ack.ok,
      messageId: ack.messageId ?? undefined,
      sequenceNumber: ack.sequenceNumber ?? undefined,
      duplicate: ack.duplicate,
      error: (ack.error ?? undefined) as MessageAck["error"],
    };
  }

  function toDmAck(ack: WireAck): DmMessageAck {
    return {
      ok: ack.ok,
      messageId: ack.messageId ?? undefined,
      duplicate: ack.duplicate,
      error: (ack.error ?? undefined) as DmMessageAck["error"],
    };
  }

  function sendFileMessage(p: ChatroomFileMessagePayload): void {
    // File/location messages go over REST; the broadcast comes back through the room topic like any other.
    const { chatroomId, ...rest } = p;
    void api.post(`/api/v1/chatrooms/${chatroomId}/messages/file`, rest).catch((err) => {
      dispatch("messageError", { message: err?.response?.data?.detail ?? "Failed to send attachment" });
    });
  }

  // ── the Socket.IO-shaped surface ─────────────────────────────────────────

  const socket: AppSocket = {
    get connected() {
      return client.connected;
    },
    get id() {
      return id;
    },
    connect() {
      if (!client.active) client.activate();
    },
    disconnect() {
      rooms.clear();
      dms.clear();
      for (const p of pendingAcks.values()) if (p.timer) clearTimeout(p.timer);
      pendingAcks.clear();
      void client.deactivate();
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler as Handler);
      return this;
    },
    once(event, handler) {
      const wrapped = ((...args: never[]) => {
        socket.off(event, wrapped as unknown as Incoming[typeof event]);
        (handler as Handler)(...args);
      }) as Handler;
      return socket.on(event, wrapped as unknown as Incoming[typeof event]);
    },
    off(event, handler) {
      if (!handler) listeners.delete(event);
      else listeners.get(event)?.delete(handler as Handler);
      return this;
    },
    emit(event, ...args) {
      const [payload, ack] = args as [unknown, ((a: unknown) => void) | undefined];
      switch (event) {
        case "heartbeat":
          publish("/app/presence/heartbeat", {});
          break;
        case "joinRoom":
          subscribeRoom((payload as { chatroomId: string }).chatroomId);
          break;
        case "leaveRoom": {
          const rid = (payload as { chatroomId: string }).chatroomId;
          rooms.get(rid)?.unsubscribe();
          rooms.delete(rid);
          break;
        }
        case "presenceUpdate":
          publish("/app/presence/update", payload);
          break;
        case "chatroomMessage":
          sendWithAck("/app/rooms/send", payload as Record<string, unknown>, ack && ((a) => ack(toMessageAck(a))));
          break;
        case "chatroomFileMessage":
          sendFileMessage(payload as ChatroomFileMessagePayload);
          break;
        case "markRead":
          publish("/app/rooms/read", payload);
          break;
        case "messageDelivered":
          publish("/app/rooms/delivered", payload);
          break;
        case "typing":
          publish("/app/rooms/typing", payload);
          break;
        case "stopTyping":
          publish("/app/rooms/stopTyping", payload);
          break;
        case "joinDM":
          subscribeDm((payload as { conversationId: string }).conversationId);
          break;
        case "leaveDM": {
          const cid = (payload as { conversationId: string }).conversationId;
          dms.get(cid)?.unsubscribe();
          dms.delete(cid);
          break;
        }
        case "directMessage":
          sendWithAck("/app/dm/send", payload as Record<string, unknown>, ack && ((a) => ack(toDmAck(a))));
          break;
        case "dmTyping":
          publish("/app/dm/typing", payload);
          break;
        case "dmStopTyping":
          publish("/app/dm/stopTyping", payload);
          break;
        case "syncOfflineQueue":
          syncAck = (ack as (() => void) | undefined) ?? null;
          publish("/app/rooms/sync", payload);
          break;
        case "reactionToggled":
        case "messageEdited":
        case "messageDeleted":
        case "messagePinned":
          // Relays from the Socket.IO era: the REST write already happened and the
          // server broadcasts the result to the room itself. Nothing to send.
          break;
        default:
          console.warn(`stompSocket: unmapped client event "${String(event)}"`);
      }
      return this;
    },
    timeout(ms) {
      return {
        emit(event, payload, cb) {
          const destination = event === "chatroomMessage" ? "/app/rooms/send" : "/app/dm/send";
          if (!client.connected) {
            cb(new Error("not connected"));
            return;
          }
          sendWithAck(
            destination,
            payload as unknown as Record<string, unknown>,
            (a) => {
              if (a.error === "timeout") cb(new Error("ack timeout"));
              else cb(null, (event === "chatroomMessage" ? toMessageAck(a) : toDmAck(a)) as never);
            },
            ms
          );
        },
      };
    },
  };

  client.activate();
  return socket;
}
