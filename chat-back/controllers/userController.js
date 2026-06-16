const mongoose = require("mongoose");
const User = mongoose.model("User");
const bcrypt = require("bcryptjs");
const jwt = require("jwt-then");
const logger = require("../utils/logger");

exports.register = async (req, res) => {
  const { name, email, password, dp } = req.body;
  if (!name || !email || !password) throw "Name, email, and password are required.";
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) throw "Please provide a valid email address.";
  if (password.length < 6) throw "Password must be at least 6 characters long.";
  if (name.length > 50) throw "Name cannot exceed 50 characters.";
  const userExists = await User.findOne({ email: email.toLowerCase() });
  if (userExists) throw "User with this email already exists.";
  const hashedPassword = await bcrypt.hash(password, 12);
  const user = new User({ name, email: email.toLowerCase(), password: hashedPassword, dp: dp || "" });
  await user.save();
  const token = await jwt.sign({ id: user.id }, process.env.SECRET);
  logger.info("User registered", { userId: user.id });
  res.json({
    message: "User [" + name + "] registered successfully!",
    token,
    user: { id: user.id, name: user.name, email: user.email, dp: user.dp, bio: user.bio || "" },
  });
};

exports.login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw "Email and password are required.";
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw "Email and password did not match.";
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) throw "Email and password did not match.";
  const token = await jwt.sign({ id: user.id }, process.env.SECRET);
  user.isOnline = true;
  await user.save();
  logger.info("User logged in", { userId: user.id });
  res.json({
    message: "User logged in successfully!",
    token,
    userName: user.name,
    user: { id: user.id, name: user.name, email: user.email, dp: user.dp || "", bio: user.bio || "" },
  });
};

exports.getProfile = async (req, res) => {
  const user = await User.findById(req.payload.id).select("-password");
  if (!user) throw "User not found.";
  res.json(user);
};

exports.updateProfile = async (req, res) => {
  const { name, bio } = req.body;
  const user = await User.findById(req.payload.id);
  if (!user) throw "User not found.";
  if (name && name.trim()) user.name = name.trim().slice(0, 50);
  if (bio !== undefined) user.bio = bio.slice(0, 160);
  if (req.file) user.dp = `/uploads/${req.file.filename}`;
  await user.save();
  logger.info("Profile updated", { userId: user.id });
  res.json({
    message: "Profile updated.",
    user: { id: user.id, name: user.name, email: user.email, dp: user.dp, bio: user.bio },
  });
};
