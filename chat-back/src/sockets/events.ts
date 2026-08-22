import type { Server, Socket } from "socket.io";
import type { OnlineUserPublic } from "../shared/interfaces.js";

/**
 * Single source of truth for every Socket.IO event and payload.
 * The frontend mirrors these types in chat-front/src/types/socket.ts —
 * keep the two files in sync (they will be shared properly once the repo
 * grows a common package; duplicating 150 lines beats a premature monorepo).
 */

// ── Payloads ──────────────────────────────────────────────────────────────────

export interface ReplyToRef {
  messageId: string;
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

export interface NewMessagePayload {
  _id: string;
  mentions?: string[];
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
  reactions?: unknown[];
  replyTo?: unknown;
  expiresAt?: Date | null;
  sequenceNumber: number;
  clientMessageId?: string | null;
  deliveryStatus: "sent";
  createdAt: Date;
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

export interface ReactionEntry {
  emoji: string;
  user: string;
  name?: string;
}

// ── Direct messages ───────────────────────────────────────────────────────────

/** E2EE envelope — the server validates structure, never content. */
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
  /** Plaintext body — legacy clients / pre-E2EE sends. */
  message?: string;
  /** E2EE envelope — exactly one of message/envelope must be present. */
  envelope?: DmEnvelope;
}

export interface DmMessageAck {
  ok: boolean;
  messageId?: string;
  duplicate?: boolean;
  error?: "invalid_message" | "not_participant" | "replayed_counter" | "server_error";
}

// ── Event maps ────────────────────────────────────────────────────────────────

export interface ClientToServerEvents {
  heartbeat: () => void;
  joinRoom: (p: { chatroomId: string }) => void;
  leaveRoom: (p: { chatroomId: string }) => void;
  presenceUpdate: (p: { presenceStatus: string; presenceNote: string }) => void;
  chatroomMessage: (p: ChatroomMessagePayload, ack?: (a: MessageAck) => void) => void;
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
  syncOfflineQueue: (p: { messages: OfflineQueueItem[] }) => void;
}

export interface ServerToClientEvents {
  onlineUsers: (users: OnlineUserPublic[]) => void;
  heartbeatAck: (p: { ts: number }) => void;
  userJoined: (p: { userId: string; name: string }) => void;
  newMessage: (p: NewMessagePayload) => void;
  messageError: (p: { error?: string; message: string }) => void;
  messagesRead: (p: { userId: string; chatroomId: string; upToSequence: number | null; readAt: Date }) => void;
  messageDeliveryUpdate: (p: { messageId: string; deliveredTo: string[] }) => void;
  reactionUpdated: (p: { messageId: string; reactions: ReactionEntry[] }) => void;
  messageEdited: (p: { messageId: string; newText: string }) => void;
  messageDeleted: (p: { messageId: string }) => void;
  messagePinned: (p: { messageId: string; pinned: boolean }) => void;
  userTyping: (p: { userId: string; name: string; chatroomId: string }) => void;
  userStopTyping: (p: { userId: string; chatroomId: string }) => void;
  newDirectMessage: (p: {
    conversationId: string;
    _id: string;
    type: "e2ee/v1" | "plaintext-legacy";
    message?: string;
    envelope?: DmEnvelope;
    clientMessageId?: string | null;
    userId: string;
    name: string;
    dp: string;
    createdAt: Date;
  }) => void;
  dmNotification: (p: { conversationId: string; from: string; message: string }) => void;
  mentionNotification: (p: {
    chatroomId: string;
    chatroomName: string;
    messageId: string;
    from: string;
    preview: string;
  }) => void;
  dmUserTyping: (p: { userId: string; name?: string }) => void;
  dmUserStopTyping: (p: { userId: string }) => void;
  syncOfflineQueueResult: (p: { results: SyncResultItem[] }) => void;
}

export interface SocketData {
  userId: string;
}

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents, Record<never, never>, SocketData>;
export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<never, never>, SocketData>;
