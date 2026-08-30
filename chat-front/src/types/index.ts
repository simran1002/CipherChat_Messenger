export * from "./socket";

/** Authenticated user as stored in localStorage (CC_User). */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  dp?: string;
  bio?: string;
  /** Present on /user/profile responses only. */
  twoFactorEnabled?: boolean;
}

/** Client-side delivery state for a message bubble's tick indicator. */
export type DeliveryState = "sending" | "queued" | "sent" | "delivered" | "read";

/**
 * Message shape used by the chatroom UI. Superset of the socket payload:
 * REST history rows and optimistic bubbles are normalized into this.
 */
export interface ChatMessage {
  _id: string;
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
  pinned?: boolean;
  reactions?: import("./socket").ReactionEntry[];
  replyTo?: import("./socket").ReplyToRef | null;
  expiresAt?: string | null;
  sequenceNumber?: number;
  clientMessageId?: string | null;
  deliveredTo?: string[];
  readBy?: Array<{ user: string; readAt?: string }>;
  createdAt: string;
  /** Optimistic-UI flag: true until the server ACK replaces this bubble. */
  _pending?: boolean;
}

/** DM conversation list row (GET /dm). */
export interface DmConversation {
  _id: string;
  participant: { _id: string; name: string; email?: string; dp?: string } | null;
  lastMessage: { message: string; encrypted?: boolean; createdAt: string } | null;
  lastMessageAt: string;
}

/** Single DM message (GET /dm/:id/messages and socket receive), post-decrypt. */
export interface DmMessage {
  _id: string;
  type?: "e2ee/v1" | "plaintext-legacy";
  message: string; // decrypted plaintext, legacy body, or placeholder
  envelope?: import("./socket").DmEnvelope;
  clientMessageId?: string | null;
  encrypted?: boolean; // rendered from an e2ee envelope
  undecryptable?: boolean; // envelope present but no session/key
  edited?: boolean;
  userId: string;
  name?: string;
  dp?: string;
  createdAt: string;
  _pending?: boolean;
}

export interface Chatroom {
  _id: string;
  name: string;
  createdBy?: { _id: string; name: string } | null;
  createdAt?: string;
}
