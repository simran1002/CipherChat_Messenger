const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: "Name is required!",
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
      required: "Password is required!",
    },
    dp: { type: String, default: "" },
    bio: { type: String, default: "", maxlength: [160, "Bio cannot exceed 160 characters"] },
    lastSeen: { type: Date, default: null },
    isOnline: { type: Boolean, default: false },
    // Presence intelligence: what the user is currently doing
    presenceStatus: {
      type: String,
      default: "available",
      enum: ["available", "coding", "in_meeting", "focusing", "driving", "away", "busy"],
    },
    presenceNote: { type: String, default: "", maxlength: [80] },
  },
  { timestamps: true }
);

userSchema.index({ email: 1 });

module.exports = mongoose.model("User", userSchema);
