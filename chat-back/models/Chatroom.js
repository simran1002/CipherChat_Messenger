const mongoose = require("mongoose");

const chatroomSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: "Name is required!",
      trim: true,
      maxlength: [50, "Chatroom name cannot exceed 50 characters"],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

chatroomSchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model("Chatroom", chatroomSchema);
