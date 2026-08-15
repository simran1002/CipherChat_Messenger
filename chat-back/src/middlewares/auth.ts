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
  if (typeof decoded === "string" || typeof decoded.id !== "string") {
    throw new jwt.JsonWebTokenError("Malformed token payload");
  }
  return { id: decoded.id };
}

/** Short-lived access token — pairs with the rotating refresh cookie. */
export const ACCESS_TOKEN_TTL = "15m";

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, env.SECRET, { algorithm: "HS256", expiresIn: ACCESS_TOKEN_TTL });
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
