import mongoose, { Schema, type InferSchemaType } from "mongoose";

/**
 * Rotating refresh tokens. The raw token is an opaque 256-bit random string
 * that only ever lives in an httpOnly cookie; we store its SHA-256 hash so a
 * database dump cannot be replayed as a session. One row per live session;
 * rotation deletes the used row and inserts a fresh one (reuse of a deleted
 * token is how theft is detected).
 */
const refreshTokenSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    createdByIp: { type: String, default: "" },
  },
  { timestamps: true }
);

// Mongo TTL sweep removes expired sessions automatically
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RefreshTokenAttrs = InferSchemaType<typeof refreshTokenSchema>;

export const RefreshToken = mongoose.model("RefreshToken", refreshTokenSchema);
