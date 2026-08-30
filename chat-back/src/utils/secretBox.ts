import crypto from "node:crypto";
import { env } from "../config/env.js";

/**
 * Reversible encryption for small server-side secrets that must be readable
 * again (TOTP seeds — unlike passwords, they're compared by *recomputing*
 * codes). AES-256-GCM under a key derived from SECRET, so a database dump
 * alone doesn't yield working authenticator seeds.
 *
 * Deliberately NOT for user content — content encryption is the client's job
 * (E2EE). This only raises the bar from "read the users collection" to
 * "read the users collection AND the app server's environment".
 */
const key = crypto.createHash("sha256").update(`${env.SECRET}:2fa-secret-box:v1`).digest();

export function seal(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function open(sealed: string): string {
  const raw = Buffer.from(sealed, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
