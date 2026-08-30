import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";

export interface AuthPayload {
  id: string;
}

const VERIFY_OPTIONS: jwt.VerifyOptions = {
  // Explicit algorithm allowlist — never accept "none" or an RS/HS confusion.
  algorithms: ["HS256"],
};

/** Verify a raw JWT string and return its payload. Shared by HTTP and socket auth. */
export function verifyToken(token: string): AuthPayload {
  const decoded = jwt.verify(token, env.SECRET, VERIFY_OPTIONS) as jwt.JwtPayload | string;
  // Scoped tokens (e.g. the 5-minute 2FA-pending token issued after a correct
  // password but BEFORE the second factor) must never work as access tokens —
  // an access token is exactly {id} with no scope claim.
  if (typeof decoded === "string" || typeof decoded.id !== "string" || decoded.scope !== undefined) {
    throw new jwt.JsonWebTokenError("Malformed token payload");
  }
  return { id: decoded.id };
}

/** Short-lived access token — pairs with the rotating refresh cookie. */
export const ACCESS_TOKEN_TTL = "15m";

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, env.SECRET, { algorithm: "HS256", expiresIn: ACCESS_TOKEN_TTL });
}

// ── 2FA pending tokens ────────────────────────────────────────────────────
// Proof that the password step succeeded, worth nothing anywhere else:
// verifyToken above rejects any token carrying a scope claim.

const TWO_FACTOR_SCOPE = "2fa-pending";
export const TWO_FACTOR_PENDING_TTL = "5m";

export function sign2faPendingToken(userId: string): string {
  return jwt.sign({ id: userId, scope: TWO_FACTOR_SCOPE }, env.SECRET, {
    algorithm: "HS256",
    expiresIn: TWO_FACTOR_PENDING_TTL,
  });
}

/** Returns the userId, or throws (invalid, expired, or not a pending token). */
export function verify2faPendingToken(token: string): string {
  const decoded = jwt.verify(token, env.SECRET, VERIFY_OPTIONS) as jwt.JwtPayload | string;
  if (typeof decoded === "string" || typeof decoded.id !== "string" || decoded.scope !== TWO_FACTOR_SCOPE) {
    throw new jwt.JsonWebTokenError("Not a 2FA pending token");
  }
  return decoded.id;
}

export function auth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const [scheme, token] = header?.split(" ") ?? [];

  if (!header || scheme !== "Bearer" || !token) {
    res.status(401).json({ message: "Authentication required", code: "unauthorized" });
    return;
  }

  try {
    req.payload = verifyToken(token);
    next();
  } catch (err) {
    const expired = err instanceof jwt.TokenExpiredError;
    res.status(401).json({
      message: expired ? "Token expired" : "Invalid token",
      code: expired ? "token_expired" : "token_invalid",
    });
  }
}

export default auth;
