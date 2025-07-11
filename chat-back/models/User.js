const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: "Name is required!",
    },
    email: {
      type: String,
      required: [true, "Email is required!"],
      unique: true,
    },
    password: {
      type: String,
      required: "Password is required!",
    },
    dp: {
      type: String, // base64 string or image URL
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("User", userSchema);
