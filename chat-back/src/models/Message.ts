import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from "mongoose";

export const MESSAGE_TYPES = ["text", "image", "audio", "file", "location"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

const reactionSchema = new Schema(
  {
    emoji: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String },
  },
  { _id: false }
);

const messageSchema = new Schema(
  {
    chatroom: {
      type: Schema.Types.ObjectId,
      required: [true, "Chatroom is required!"],
      ref: "Chatroom",
    },
    user: {
      type: Schema.Types.ObjectId,
      required: [true, "User is required!"],
      ref: "User",
    },
    type: { type: String, default: "text", enum: MESSAGE_TYPES },
    message: {
      type: String,
      default: "",
      maxlength: [2000, "Message cannot exceed 2000 characters"],
    },
    fileUrl: { type: String, default: "" },
    fileName: { type: String, default: "" },
    mimeType: { type: String, default: "" },
    fileSize: { type: Number, default: 0 },
    lat: { type: Number },
    lng: { type: Number },
    replyTo: {
      messageId: { type: Schema.Types.ObjectId, ref: "Message" },
      preview: { type: String, default: "" },
      senderName: { type: String, default: "" },
    },
    reactions: { type: [reactionSchema], default: [] },
    pinned: { type: Boolean, default: false },
    edited: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
    scheduledFor: { type: Date, default: null },
    expiresAt: { type: Date, default: null },

    // ── Delivery guarantee ───────────────────────────────────────────────────
    // Client-generated idempotency key (UUID v4) for deduplication
    clientMessageId: { type: String, default: null },
    // Monotonic per-room sequence number for ordered delivery
    sequenceNumber: { type: Number, default: 0 },
    // Delivery receipts — socket-confirmed receivers
    deliveredTo: [{ type: Schema.Types.ObjectId, ref: "User" }],
    // Read receipts — users who have seen this message
    readBy: {
      type: [
        new Schema(
          {
            user: { type: Schema.Types.ObjectId, ref: "User" },
            readAt: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);

messageSchema.index({ chatroom: 1, createdAt: -1 });
messageSchema.index({ chatroom: 1, pinned: 1 });
messageSchema.index({ chatroom: 1, sequenceNumber: 1 });
messageSchema.index({ clientMessageId: 1 }, { sparse: true });
messageSchema.index({ chatroom: 1, message: "text" });
messageSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: "date" } } }
);

export type MessageAttrs = InferSchemaType<typeof messageSchema>;
export type MessageDocument = HydratedDocument<MessageAttrs>;

export const Message = mongoose.model("Message", messageSchema);
