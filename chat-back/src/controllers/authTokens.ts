import crypto from "node:crypto";
import type { Request, Response } from "express";
import { RefreshToken } from "../models/RefreshToken.js";
import { env } from "../config/env.js";

export const REFRESH_COOKIE = "CC_Refresh";
const REFRESH_TTL_DAYS = 30;

function hash(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** Issue a fresh refresh token for the user and set it as an httpOnly cookie. */
export async function issueRefreshToken(res: Response, userId: string, ip?: string): Promise<void> {
  const raw = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

  await RefreshToken.create({ user: userId, tokenHash: hash(raw), expiresAt, createdByIp: ip ?? "" });

  res.cookie(REFRESH_COOKIE, raw, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.ENV !== "DEVELOPMENT" && env.ENV !== "TEST",
    path: "/user",
    maxAge: REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

/**
 * Rotate: consume the presented refresh token, return the owning userId.
 * Returns null when the token is unknown (expired, revoked, or reused after
 * rotation — the theft-detection case).
 */
export async function rotateRefreshToken(req: Request, res: Response): Promise<string | null> {
  const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  if (!raw) return null;

  const row = await RefreshToken.findOneAndDelete({
    tokenHash: hash(raw),
    expiresAt: { $gt: new Date() },
  });
  if (!row) {
    res.clearCookie(REFRESH_COOKIE, { path: "/user" });
    return null;
  }

  const userId = row.user.toString();
  await issueRefreshToken(res, userId, req.ip);
  return userId;
}

/** Revoke the presented refresh token and clear the cookie. */
export async function revokeRefreshToken(req: Request, res: Response): Promise<void> {
  const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  if (raw) {
    await RefreshToken.deleteOne({ tokenHash: hash(raw) });
  }
  res.clearCookie(REFRESH_COOKIE, { path: "/user" });
}
