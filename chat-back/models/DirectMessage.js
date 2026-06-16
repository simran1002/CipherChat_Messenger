const mongoose = require("mongoose");

const dmMessageSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  message: { type: String, required: true, maxlength: [2000, "Message too long"] },
  edited: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const directMessageSchema = new mongoose.Schema(
  {
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }],
    messages: [dmMessageSchema],
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

directMessageSchema.index({ participants: 1 });
directMessageSchema.index({ lastMessageAt: -1 });

module.exports = mongoose.model("DirectMessage", directMessageSchema);
