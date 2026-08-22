import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { HttpError } from "../errors/HttpError.js";
import { signToken } from "../middlewares/auth.js";
import {
  issueRefreshToken,
  listSessions,
  revokeOtherSessions,
  revokeRefreshToken,
  revokeSessionById,
  rotateRefreshToken,
} from "./authTokens.js";
import mongoose from "mongoose";
import { fileStorage } from "../storage/index.js";
import { logger } from "../utils/logger.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function register(req: Request, res: Response): Promise<void> {
  const { name, email, password, dp } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    dp?: string;
  };

  if (!name || !email || !password) throw HttpError.badRequest("Name, email, and password are required.");
  if (!EMAIL_REGEX.test(email)) throw HttpError.badRequest("Please provide a valid email address.");
  if (password.length < 6) throw HttpError.badRequest("Password must be at least 6 characters long.");
  if (name.length > 50) throw HttpError.badRequest("Name cannot exceed 50 characters.");

  const userExists = await User.findOne({ email: email.toLowerCase() });
  if (userExists) throw HttpError.conflict("User with this email already exists.", "email_taken");

  const hashedPassword = await bcrypt.hash(password, 12);
  const user = new User({ name, email: email.toLowerCase(), password: hashedPassword, dp: dp || "" });
  await user.save();

  const token = signToken({ id: user.id });
  await issueRefreshToken(res, user.id, req.ip);
  logger.info("User registered", { userId: user.id });
  res.json({
    message: "User [" + name + "] registered successfully!",
    token,
    user: { id: user.id, name: user.name, email: user.email, dp: user.dp, bio: user.bio || "" },
  });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) throw HttpError.badRequest("Email and password are required.");

  // password is select:false on the schema now — opt in explicitly
  const user = await User.findOne({ email: email.toLowerCase() }).select("+password");
  if (!user) throw HttpError.unauthorized("Email and password did not match.", "bad_credentials");

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) throw HttpError.unauthorized("Email and password did not match.", "bad_credentials");

  const token = signToken({ id: user.id });
  await issueRefreshToken(res, user.id, req.ip);
  user.isOnline = true;
  await user.save();
  logger.info("User logged in", { userId: user.id });
  res.json({
    message: "User logged in successfully!",
    token,
    userName: user.name,
    user: { id: user.id, name: user.name, email: user.email, dp: user.dp || "", bio: user.bio || "" },
  });
}

/**
 * POST /user/refresh — rotate the refresh cookie, mint a new access token.
 * 401 when the cookie is missing/expired/reused (client must re-login).
 */
export async function refresh(req: Request, res: Response): Promise<void> {
  const userId = await rotateRefreshToken(req, res);
  if (!userId) throw HttpError.unauthorized("Refresh token invalid or expired.", "refresh_invalid");
  const token = signToken({ id: userId });
  res.json({ token });
}

/** POST /user/logout — revoke the session's refresh token. */
export async function logout(req: Request, res: Response): Promise<void> {
  await revokeRefreshToken(req, res);
  res.json({ message: "Logged out." });
}

/** GET /user/sessions — every live session for the caller, current one flagged. */
export async function getSessions(req: Request, res: Response): Promise<void> {
  res.json({ sessions: await listSessions(req, req.payload!.id) });
}

/** DELETE /user/sessions/:sessionId — revoke one session (owner-scoped). */
export async function revokeSession(req: Request, res: Response): Promise<void> {
  const { sessionId } = req.params as { sessionId: string };
  if (!mongoose.Types.ObjectId.isValid(sessionId)) throw HttpError.badRequest("Invalid session ID.");
  const revoked = await revokeSessionById(req.payload!.id, sessionId);
  if (!revoked) throw HttpError.notFound("Session not found.", "session_not_found");
  logger.info("Session revoked", { userId: req.payload!.id, sessionId });
  res.json({ message: "Session revoked.", sessionId });
}

/** DELETE /user/sessions — revoke all OTHER sessions ("sign out everywhere else"). */
export async function revokeOthers(req: Request, res: Response): Promise<void> {
  const revoked = await revokeOtherSessions(req, req.payload!.id);
  logger.info("Other sessions revoked", { userId: req.payload!.id, revoked });
  res.json({ message: `Signed out of ${revoked} other session(s).`, revoked });
}

export async function getProfile(req: Request, res: Response): Promise<void> {
  const user = await User.findById(req.payload!.id);
  if (!user) throw HttpError.notFound("User not found.");
  res.json(user);
}

export async function updateProfile(req: Request, res: Response): Promise<void> {
  const { name, bio } = req.body as { name?: string; bio?: string };
  const user = await User.findById(req.payload!.id);
  if (!user) throw HttpError.notFound("User not found.");
  if (name && name.trim()) user.name = name.trim().slice(0, 50);
  if (bio !== undefined) user.bio = bio.slice(0, 160);
  if (req.file) {
    const previousKey = user.dp ? fileStorage.keyFromUrl(user.dp) : null;
    const stored = await fileStorage.put(req.file);
    user.dp = stored.url;
    // The old avatar used to leak on disk forever — reclaim it (best-effort)
    if (previousKey) void fileStorage.delete(previousKey);
  }
  await user.save();
  logger.info("Profile updated", { userId: user.id });
  res.json({
    message: "Profile updated.",
    user: { id: user.id, name: user.name, email: user.email, dp: user.dp, bio: user.bio },
  });
}
