import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from "mongoose";

export const PRESENCE_STATUSES = [
  "available",
  "coding",
  "in_meeting",
  "focusing",
  "driving",
  "away",
  "busy",
] as const;

export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

const userSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required!"],
      trim: true,
      maxlength: [50, "Name cannot exceed 50 characters"],
    },
    email: {
      type: String,
      required: [true, "Email is required!"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, "Password is required!"],
      select: false,
    },
    dp: { type: String, default: "" },
    bio: { type: String, default: "", maxlength: [160, "Bio cannot exceed 160 characters"] },
    lastSeen: { type: Date, default: null },
    isOnline: { type: Boolean, default: false },
    // Presence intelligence: what the user is currently doing
    presenceStatus: {
      type: String,
      default: "available",
      enum: PRESENCE_STATUSES,
    },
    presenceNote: { type: String, default: "", maxlength: 80 },
  },
  { timestamps: true }
);

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<UserAttrs>;

export const User = mongoose.model("User", userSchema);
