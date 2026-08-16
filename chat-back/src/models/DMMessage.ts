import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from "mongoose";
import type { DmEnvelope } from "../sockets/events.js";

export const DM_MESSAGE_TYPES = ["e2ee/v1", "plaintext-legacy"] as const;
export type DmMessageType = (typeof DM_MESSAGE_TYPES)[number];

/**
 * One document per direct message.
 *
 * Replaces the embedded messages[] array on DirectMessage, which rewrote the
 * whole conversation document on every send and was marching toward the 16MB
 * document cap. Pagination becomes an indexed range scan.
 *
 * Two shapes, discriminated by `type`:
 *  - "plaintext-legacy": pre-E2EE history (and interim writes until the E2EE
 *    client ships) — content in `body`.
 *  - "e2ee/v1": content is an opaque envelope; the server validates structure
 *    only and can never read it.
 *
 * `envelope` is stored as Mixed rather than a nested Schema. Mongoose 8 has a
 * hydration bug with a Schema-typed field nested inside another Schema-typed
 * field (envelope.init would have been a subdocument-within-a-subdocument):
 * the write succeeds but every subsequent read silently comes back with the
 * whole parent field undefined, with no error anywhere. Structural validation
 * of the envelope already happens at the socket boundary
 * (sockets/dmHandlers.ts validEnvelope()) before a write is ever attempted,
 * so Mongoose-level subdocument typing here was redundant defense, not a
 * correctness requirement — Mixed is the pragmatic, verified-safe choice.
 * The dotted-path unique index below still indexes correctly: MongoDB
 * indexes operate on the actual BSON shape, independent of how Mongoose
 * types the field.
 */
const dmMessageSchema = new Schema(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "DirectMessage",
      required: true,
    },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    clientMessageId: { type: String, default: null },
    type: { type: String, enum: DM_MESSAGE_TYPES, required: true },
    body: { type: String, default: "", maxlength: [2000, "Message too long"] },
    envelope: { type: Schema.Types.Mixed },
    edited: { type: Boolean, default: false },
  },
  { timestamps: true }
);

dmMessageSchema.index({ conversationId: 1, createdAt: -1 });
// Idempotent retries: the same client send can never persist twice
dmMessageSchema.index(
  { conversationId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: "string" } } }
);
// Replay backstop for E2EE: one (session, counter) slot per sender, ever
dmMessageSchema.index(
  { conversationId: 1, senderId: 1, "envelope.sessionId": 1, "envelope.ctr": 1 },
  { unique: true, partialFilterExpression: { type: "e2ee/v1" } }
);

export type DMMessageAttrs = Omit<InferSchemaType<typeof dmMessageSchema>, "envelope"> & {
  envelope?: DmEnvelope;
};
export type DMMessageDocument = HydratedDocument<DMMessageAttrs>;

export const DMMessage = mongoose.model("DMMessage", dmMessageSchema);
