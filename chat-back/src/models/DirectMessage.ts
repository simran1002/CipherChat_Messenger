import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from "mongoose";

const dmMessageSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  message: { type: String, required: true, maxlength: [2000, "Message too long"] },
  edited: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const directMessageSchema = new Schema(
  {
    participants: [{ type: Schema.Types.ObjectId, ref: "User", required: true }],
    messages: { type: [dmMessageSchema], default: [] },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

directMessageSchema.index({ participants: 1 });
directMessageSchema.index({ lastMessageAt: -1 });

export type DirectMessageAttrs = InferSchemaType<typeof directMessageSchema>;
export type DirectMessageDocument = HydratedDocument<DirectMessageAttrs>;

export const DirectMessage = mongoose.model("DirectMessage", directMessageSchema);
