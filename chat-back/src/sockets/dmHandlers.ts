import mongoose from "mongoose";
import { DirectMessage } from "../models/DirectMessage.js";
import { DMMessage } from "../models/DMMessage.js";
import { presenceRegistry, rateLimiter } from "../shared/index.js";
import { errMessage, logger } from "../utils/logger.js";
import type { AppServer, AppSocket, DirectMessagePayload, DmEnvelope, DmMessageAck } from "./events.js";

/**
 * Ciphertext cap. Derivation: max plaintext 2000 chars → ≤8000 UTF-8 bytes
 * → padded to the next 256-byte bucket (≤8192) + 16-byte GCM tag → base64
 * inflates 4/3 → ~10.9 KB. 16 KB leaves headroom for a future larger bucket
 * without letting the relay become an arbitrary blob channel. Raising this
 * requires changing PAD_BUCKET / the plaintext limit on the client, together.
 */
const MAX_CT_BYTES = 16 * 1024;

/**
 * Structural validation of an E2EE envelope. The server cannot (and must
 * not) inspect content — it only enforces the shape so relays can't be
 * abused as an arbitrary blob channel.
 */
function validEnvelope(env: unknown): env is DmEnvelope {
  if (typeof env !== "object" || env === null) return false;
  const e = env as Record<string, unknown>;
  if (e.v !== 1) return false;
  if (typeof e.sessionId !== "string" || e.sessionId.length > 64) return false;
  if (typeof e.ctr !== "number" || !Number.isInteger(e.ctr) || e.ctr < 0) return false;
  if (typeof e.ct !== "string" || e.ct.length === 0 || e.ct.length > MAX_CT_BYTES) return false;
  if (e.init !== undefined) {
    const i = e.init as Record<string, unknown>;
    if (typeof i !== "object" || i === null) return false;
    if (typeof i.ephPub !== "string" || i.ephPub.length > 64) return false;
    if (typeof i.ik !== "string" || i.ik.length > 64) return false;
    if (typeof i.spkId !== "number") return false;
  }
  return true;
}

/**
 * Conversation participants are immutable (a DM is always the same two
 * people), so they cache aggressively — the send path used to load the whole
 * conversation document per message just to authorize and find the peer.
 */
const PARTICIPANTS_TTL_MS = 5 * 60 * 1000;
const PARTICIPANTS_MAX = 2000;
const participantsCache = new Map<string, { participants: string[]; expiresAt: number }>();

async function conversationParticipants(conversationId: string): Promise<string[] | null> {
  const hit = participantsCache.get(conversationId);
  if (hit && hit.expiresAt > Date.now()) return hit.participants;

  if (!mongoose.Types.ObjectId.isValid(conversationId)) return null;
  const conv = await DirectMessage.findById(conversationId).select("participants").lean();
  if (!conv) return null;
  const participants = conv.participants.map((p) => p.toString());

  if (participantsCache.size >= PARTICIPANTS_MAX) {
    const oldest = participantsCache.keys().next().value;
    if (oldest !== undefined) participantsCache.delete(oldest);
  }
  participantsCache.set(conversationId, { participants, expiresAt: Date.now() + PARTICIPANTS_TTL_MS });
  return participants;
}

export function registerDmHandlers(io: AppServer, socket: AppSocket): void {
  const userId = socket.data.userId;

  socket.on("joinDM", async ({ conversationId }) => {
    // Only participants may join a DM room (previously unchecked)
    const participants = await conversationParticipants(conversationId);
    if (participants?.includes(userId)) socket.join(`dm:${conversationId}`);
  });

  socket.on("leaveDM", ({ conversationId }) => {
    socket.leave(`dm:${conversationId}`);
  });

  socket.on("directMessage", async (payload: DirectMessagePayload, ackFn) => {
    const ack = (a: DmMessageAck) => {
      if (typeof ackFn === "function") ackFn(a);
    };
    try {
      const { conversationId, message, envelope, clientMessageId } = payload;

      if (!mongoose.Types.ObjectId.isValid(conversationId)) {
        return ack({ ok: false, error: "invalid_message" });
      }

      // DM sends share the same per-user token bucket as room messages
      if (!(await rateLimiter.allow(userId))) {
        return ack({ ok: false, error: "server_error" });
      }

      // Exactly one content shape
      const isPlain = typeof message === "string" && message.trim().length > 0;
      const isE2ee = envelope !== undefined;
      if (isPlain === isE2ee) return ack({ ok: false, error: "invalid_message" });
      if (isPlain && message!.length > 2000) return ack({ ok: false, error: "invalid_message" });
      if (isE2ee && !validEnvelope(envelope)) return ack({ ok: false, error: "invalid_message" });

      const participants = await conversationParticipants(conversationId);
      if (!participants || !participants.includes(userId)) {
        return ack({ ok: false, error: "not_participant" });
      }

      // Idempotent retries
      if (clientMessageId) {
        const existing = await DMMessage.findOne({ conversationId, clientMessageId }).select("_id");
        if (existing) {
          return ack({ ok: true, messageId: existing._id.toString(), duplicate: true });
        }
      }

      let saved;
      try {
        saved = await DMMessage.create({
          conversationId,
          senderId: userId,
          clientMessageId: clientMessageId || null,
          type: isE2ee ? "e2ee/v1" : "plaintext-legacy",
          body: isPlain ? message!.trim() : "",
          envelope: isE2ee ? envelope : undefined,
        });
      } catch (err) {
        // Unique-index races: concurrent retry (clientMessageId) or replayed
        // E2EE counter — both are duplicate-shaped, not failures.
        if (err instanceof Error && "code" in err && (err as { code?: number }).code === 11000) {
          if (clientMessageId) {
            const winner = await DMMessage.findOne({ conversationId, clientMessageId }).select("_id");
            if (winner) return ack({ ok: true, messageId: winner._id.toString(), duplicate: true });
          }
          return ack({ ok: false, error: "replayed_counter" });
        }
        throw err;
      }

      // Conversation-ordering metadata — off the ack path
      void DirectMessage.updateOne({ _id: conversationId }, { lastMessageAt: new Date() }).catch(
        () => {}
      );

      const sender = await presenceRegistry.get(userId);
      const wire = {
        conversationId,
        _id: saved._id.toString(),
        type: saved.type as "e2ee/v1" | "plaintext-legacy",
        message: isPlain ? saved.body : undefined,
        envelope: isE2ee ? (envelope as DmEnvelope) : undefined,
        clientMessageId: clientMessageId || null,
        userId,
        name: sender?.name || "Unknown",
        dp: sender?.dp || "",
        createdAt: saved.createdAt,
      };

      ack({ ok: true, messageId: saved._id.toString() });
      io.to(`dm:${conversationId}`).emit("newDirectMessage", wire);

      const otherId = participants.find((p) => p !== userId);
      if (otherId) {
        // Per-user room — reaches the recipient on ANY replica via the Redis
        // adapter. Content-free for E2EE messages: the server has nothing to
        // preview, and deliberately never forwards ciphertext in
        // notifications.
        io.to(`user:${otherId}`).emit("dmNotification", {
          conversationId,
          from: sender?.name || "Someone",
          message: isPlain ? message!.trim().slice(0, 80) : "🔒 Encrypted message",
        });
      }
    } catch (err) {
      logger.error("Error sending DM", { error: errMessage(err) });
      ack({ ok: false, error: "server_error" });
    }
  });

  socket.on("dmTyping", async ({ conversationId }) => {
    const u = await presenceRegistry.get(userId);
    if (u) socket.to(`dm:${conversationId}`).emit("dmUserTyping", { userId, name: u.name });
  });

  socket.on("dmStopTyping", ({ conversationId }) => {
    socket.to(`dm:${conversationId}`).emit("dmUserStopTyping", { userId });
  });
}
