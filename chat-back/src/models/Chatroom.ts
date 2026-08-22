import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from "mongoose";

export const ROOM_ROLES = ["owner", "admin", "member"] as const;
export type RoomRole = (typeof ROOM_ROLES)[number];

const memberSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ROOM_ROLES, default: "member" },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

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
    /**
     * Membership + roles. Public rooms: membership is a participation record
     * (auto-added on join/first message). Private rooms: membership IS the
     * access control — non-members cannot read, search, or send.
     */
    members: { type: [memberSchema], default: [] },
    isPrivate: { type: Boolean, default: false },
  },
  { timestamps: true }
);

chatroomSchema.index({ name: 1 }, { unique: true });
chatroomSchema.index({ "members.user": 1 });

export type ChatroomAttrs = InferSchemaType<typeof chatroomSchema>;
export type ChatroomDocument = HydratedDocument<ChatroomAttrs>;

export const Chatroom = mongoose.model("Chatroom", chatroomSchema);
