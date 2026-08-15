import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from "mongoose";

const chatroomSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required!"],
      trim: true,
      maxlength: [50, "Chatroom name cannot exceed 50 characters"],
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

chatroomSchema.index({ name: 1 }, { unique: true });

export type ChatroomAttrs = InferSchemaType<typeof chatroomSchema>;
export type ChatroomDocument = HydratedDocument<ChatroomAttrs>;

export const Chatroom = mongoose.model("Chatroom", chatroomSchema);
