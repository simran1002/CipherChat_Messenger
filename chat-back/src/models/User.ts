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

    // ── E2EE key directory ───────────────────────────────────────────────────
    // Public identity + signed prekey bundle. The server verifies the prekey
    // signature on publish (the only crypto it can do) and hands bundles to
    // peers; it never sees a private key. keyVersion increments on every
    // reset so clients can detect identity changes (safety-number warning).
    keys: {
      type: new Schema(
        {
          identityEd25519: { type: String, required: true }, // base64 pub
          identityX25519: { type: String, required: true }, // base64 pub
          signedPreKey: {
            keyId: { type: Number, required: true },
            pubX25519: { type: String, required: true },
            sig: { type: String, required: true }, // Ed25519 over pubX25519 bytes
          },
          keyVersion: { type: Number, required: true, default: 1 },
          publishedAt: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: undefined,
    },
    // Opaque client-encrypted backup blob (identity + sessions wrapped under
    // the recovery code). The server stores it, cannot read it.
    keyBackup: { type: String, default: undefined, select: false, maxlength: 131072 },

    // ── Two-factor authentication (TOTP) ────────────────────────────────────
    // secret is the base32 TOTP seed sealed with AES-256-GCM (utils/secretBox)
    // so a DB dump alone can't mint codes; backupCodes are bcrypt hashes,
    // removed as they're consumed (single-use). enabled=false means setup was
    // started but never confirmed with a live code.
    twoFactor: {
      type: new Schema(
        {
          enabled: { type: Boolean, required: true, default: false },
          secret: { type: String, required: true },
          backupCodes: { type: [String], default: [] },
          enabledAt: { type: Date, default: undefined },
        },
        { _id: false }
      ),
      default: undefined,
      select: false,
    },
  },
  { timestamps: true }
);

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<UserAttrs>;

export const User = mongoose.model("User", userSchema);
