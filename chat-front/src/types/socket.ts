import type { AppSocket as StompAppSocket } from "../services/stompSocket";

/**
 * Mirrors backend/src/main/java/com/cipherchat/gateway/WsPayloads.java and
 * the STOMP destinations wired up in StompController/PresenceGateway — keep
 * the two in sync. Transport is `../services/stompSocket.ts` (STOMP over a
 * raw WebSocket at /ws); this file only carries the payload/event shapes the
 * pages and hooks were already written against.
 */

export interface ReplyToRef {
  /** Numeric on the wire (backend `ReplyRef.messageId` is a Long) — accept either. */
  messageId: string | number;
  preview?: string;
  senderName?: string;
}

export interface ChatroomMessagePayload {
  chatroomId: string;
  message: string;
  replyTo?: ReplyToRef;
  expiresIn?: number;
  clientMessageId?: string;
  /** User ids selected via the composer's @mention autocomplete (max 10). */
  mentions?: string[];
}

export interface ChatroomFileMessagePayload {
  chatroomId: string;
  type?: "image" | "audio" | "file" | "location";
  message?: string;
  fileUrl?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  lat?: number;
  lng?: number;
  replyTo?: ReplyToRef;
  clientMessageId?: string;
}

export interface MessageAck {
  ok: boolean;
  messageId?: string;
  sequenceNumber?: number;
  duplicate?: boolean;
  error?: "rate_limited" | "invalid_message" | "forbidden" | "server_error";
  message?: string;
}

export interface ReactionEntry {
  emoji: string;
  user: string;
  name?: string;
}

/** Flat sender fields (ChatroomDtos.MessageView) — no nested `user` object. */
export interface NewMessagePayload {
  id: string;
  mentions?: string[];
  deliveredTo?: string[];
  type: string;
  message: string;
  name: string;
  userId: string;
  dp: string;
  fileUrl?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  lat?: number | null;
  lng?: number | null;
  edited?: boolean;
  reactions?: ReactionEntry[];
  replyTo?: ReplyToRef | null;
  expiresAt?: string | null;
  sequenceNumber: number;
  clientMessageId?: string | null;
  deliveryStatus: "sent";
  createdAt: string;
}

export interface OnlineUserPublic {
  userId: string;
  name: string;
  dp: string;
  presenceStatus: string;
  presenceNote: string;
}

export interface OfflineQueueItem {
  chatroomId: string;
  message: string;
  clientMessageId?: string;
}

export interface SyncResultItem {
  clientMessageId?: string;
  messageId?: string;
  ok?: boolean;
  duplicate?: boolean;
  error?: string;
}

/** E2EE envelope — mirrors chat-back DmEnvelope. */
export interface DmEnvelope {
  v: number;
  sessionId: string;
  ctr: number;
  ct: string;
  init?: { ephPub: string; ik: string; spkId: number };
}

export interface DirectMessagePayload {
  conversationId: string;
  clientMessageId?: string;
  message?: string;
  envelope?: DmEnvelope;
}

export interface DmMessageAck {
  ok: boolean;
  messageId?: string;
  duplicate?: boolean;
  error?: "invalid_message" | "not_participant" | "replayed_counter" | "server_error";
}

export interface NewDirectMessagePayload {
  conversationId: string;
  id: string;
  type: "e2ee/v1" | "plaintext-legacy";
  message?: string;
  envelope?: DmEnvelope;
  clientMessageId?: string | null;
  userId: string;
  name: string;
  dp: string;
  createdAt: string;
}

/** Events the client sends. */
export interface ClientToServerEvents {
  heartbeat: () => void;
  joinRoom: (p: { chatroomId: string }) => void;
  leaveRoom: (p: { chatroomId: string }) => void;
  presenceUpdate: (p: { presenceStatus: string; presenceNote: string }) => void;
  chatroomMessage: (p: ChatroomMessagePayload, ack: (a: MessageAck) => void) => void;
  chatroomFileMessage: (p: ChatroomFileMessagePayload) => void;
  markRead: (p: { chatroomId: string; upToSequence?: number }) => void;
  messageDelivered: (p: { messageId: string; chatroomId: string }) => void;
  reactionToggled: (p: { chatroomId: string; messageId: string; reactions: ReactionEntry[] }) => void;
  messageEdited: (p: { chatroomId: string; messageId: string; newText: string }) => void;
  messageDeleted: (p: { chatroomId: string; messageId: string }) => void;
  messagePinned: (p: { chatroomId: string; messageId: string; pinned: boolean }) => void;
  typing: (p: { chatroomId: string }) => void;
  stopTyping: (p: { chatroomId: string }) => void;
  joinDM: (p: { conversationId: string }) => void;
  leaveDM: (p: { conversationId: string }) => void;
  directMessage: (p: DirectMessagePayload, ack?: (a: DmMessageAck) => void) => void;
  dmTyping: (p: { conversationId: string }) => void;
  dmStopTyping: (p: { conversationId: string }) => void;
  syncOfflineQueue: (p: { messages: OfflineQueueItem[] }, ack?: () => void) => void;
}

/** Bounded roster: `users` is the first N entries, `total` the real headcount. */
export interface RosterPayload {
  total: number;
  users: OnlineUserPublic[];
}

/** Events the client receives. */
export interface ServerToClientEvents {
  onlineUsers: (roster: RosterPayload) => void;
  heartbeatAck: (p: { ts: number }) => void;
  userJoined: (p: { userId: string; name: string }) => void;
  newMessage: (p: NewMessagePayload) => void;
  messageError: (p: { error?: string; message: string }) => void;
  messagesRead: (p: {
    userId: string;
    chatroomId: string;
    upToSequence: number | null;
    readAt: string;
  }) => void;
  messageDeliveryUpdate: (p: { messageId: string; deliveredTo: string[] }) => void;
  reactionUpdated: (p: { messageId: string; reactions: ReactionEntry[] }) => void;
  messageEdited: (p: { messageId: string; newText: string }) => void;
  messageDeleted: (p: { messageId: string }) => void;
  messagePinned: (p: { messageId: string; pinned: boolean }) => void;
  userTyping: (p: { userId: string; name: string; chatroomId: string }) => void;
  userStopTyping: (p: { userId: string; chatroomId: string }) => void;
  newDirectMessage: (p: NewDirectMessagePayload) => void;
  /** Content-free notification; `message` is a placeholder ("🔒 Encrypted message") when `encrypted`. */
  dmNotification: (p: {
    conversationId: string;
    messageId: string;
    from: string;
    fromId: string;
    encrypted: boolean;
    message: string;
  }) => void;
  mentionNotification: (p: {
    chatroomId: string;
    chatroomName?: string;
    messageId: string;
    from: string;
    preview: string;
  }) => void;
  dmUserTyping: (p: { userId: string; name?: string }) => void;
  dmUserStopTyping: (p: { userId: string }) => void;
  syncOfflineQueueResult: (p: { results: SyncResultItem[] }) => void;
}

// Type-only re-export: the runtime socket is the STOMP shim in
// services/stompSocket.ts. Importing it as a type here (rather than the old
// socket.io-client Socket<>) avoids a runtime import cycle while keeping the
// same `AppSocket` name every page already imports from "../types".
export type AppSocket = StompAppSocket;
