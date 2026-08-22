import mongoose, { Schema, type InferSchemaType } from "mongoose";

/**
 * Per-user, per-room read watermark. `lastReadSequence` is the highest
 * message sequenceNumber the user has read; the dashboard's unread badge is
 * count(messages.seq > watermark, sender ≠ user).
 *
 * A watermark beats per-message read flags for badge math: one row per
 * (user, room) instead of one array entry per (user, message), and computing
 * a badge is a single indexed range count. The per-message readBy[] array
 * remains the source for "who has read THIS message" ticks.
 */
const roomReadStateSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    chatroom: { type: Schema.Types.ObjectId, ref: "Chatroom", required: true },
    lastReadSequence: { type: Number, default: 0 },
  },
  { timestamps: true }
);

roomReadStateSchema.index({ user: 1, chatroom: 1 }, { unique: true });

export type RoomReadStateAttrs = InferSchemaType<typeof roomReadStateSchema>;

export const RoomReadState = mongoose.model("RoomReadState", roomReadStateSchema);
