import type { Request, Response } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { HttpError } from "../errors/HttpError.js";
import { signToken, sign2faPendingToken, verify2faPendingToken } from "../middlewares/auth.js";
import { issueRefreshToken } from "./authTokens.js";
import { seal, open } from "../utils/secretBox.js";
import { logger } from "../utils/logger.js";

// otplib v13 is ESM-first and its CJS entry pulls the ESM-only @scure/base —
// require()ing it crashes the compiled CJS build at boot. A dynamic import()
// (preserved verbatim by tsc under module:NodeNext) loads the ESM build fine
// from CJS, so the dependency is fetched lazily and cached. Typed with a
// structural interface: `typeof import("otplib")` resolves the package's CJS
// and ESM type declarations to "two unrelated types" (dual-package hazard).
interface OtplibApi {
  generateSecret(): string;
  generateURI(opts: { issuer: string; label: string; secret: string }): string;
  verify(opts: {
    secret: string;
    token: string;
    epochTolerance?: number | [number, number];
  }): Promise<{ valid: boolean }>;
}
let otplibPromise: Promise<OtplibApi> | null = null;
const otplib = (): Promise<OtplibApi> =>
  (otplibPromise ??= import("otplib") as unknown as Promise<OtplibApi>);

const ISSUER = "CipherChat";
/** ±30s of authenticator clock skew — one TOTP step either side. */
const EPOCH_TOLERANCE = 30;
const BACKUP_CODE_COUNT = 8;

/** Human-typeable single-use code, e.g. "K7QF-2MXR" (Crockford-ish, no 0/O/1/I). */
function makeBackupCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

const normalizeCode = (code: string): string => code.trim().toUpperCase();

async function verifyTotp(sealedSecret: string, code: string): Promise<boolean> {
  const token = code.trim();
  // otplib throws on non-numeric tokens (e.g. someone typing a backup code
  // into the TOTP path) — that's "no match", not a server error.
  if (!/^\d{6}$/.test(token)) return false;
  const { verify } = await otplib();
  const result = await verify({
    secret: open(sealedSecret),
    token,
    epochTolerance: EPOCH_TOLERANCE,
  });
  return result.valid;
}

/** Consume a backup code if it matches; true = matched (and now burned). */
async function consumeBackupCode(
  twoFactor: { backupCodes: string[] },
  code: string
): Promise<boolean> {
  const candidate = normalizeCode(code);
  for (let i = 0; i < twoFactor.backupCodes.length; i++) {
    if (await bcrypt.compare(candidate, twoFactor.backupCodes[i]!)) {
      twoFactor.backupCodes.splice(i, 1); // single-use
      return true;
    }
  }
  return false;
}

/**
 * POST /user/2fa/setup — start enrollment: mint a secret, return the
 * otpauth:// URI (client renders the QR). Not active until /2fa/enable
 * proves the authenticator actually produces matching codes.
 */
export async function setup(req: Request, res: Response): Promise<void> {
  const user = await User.findById(req.payload!.id).select("+twoFactor");
  if (!user) throw HttpError.notFound("User not found.");
  if (user.twoFactor?.enabled)
    throw HttpError.conflict("Two-factor authentication is already enabled.", "2fa_already_enabled");

  const { generateSecret, generateURI } = await otplib();
  const secret = generateSecret();
  user.twoFactor = { enabled: false, secret: seal(secret), backupCodes: [] };
  await user.save();

  res.json({
    otpauthUrl: generateURI({ issuer: ISSUER, label: user.email, secret }),
    secret, // manual-entry fallback for devices that can't scan
  });
}

/** POST /user/2fa/enable — confirm with a live code; returns backup codes ONCE. */
export async function enable(req: Request, res: Response): Promise<void> {
  const { code } = req.body as { code?: string };
  if (!code || !code.trim()) throw HttpError.badRequest("Verification code is required.");

  const user = await User.findById(req.payload!.id).select("+twoFactor");
  if (!user) throw HttpError.notFound("User not found.");
  if (!user.twoFactor) throw HttpError.badRequest("Run /user/2fa/setup first.", "2fa_not_setup");
  if (user.twoFactor.enabled)
    throw HttpError.conflict("Two-factor authentication is already enabled.", "2fa_already_enabled");

  if (!(await verifyTotp(user.twoFactor.secret, code)))
    throw HttpError.unauthorized("That code didn't match — check your authenticator app.", "2fa_bad_code");

  const backupCodes = Array.from({ length: BACKUP_CODE_COUNT }, makeBackupCode);
  user.twoFactor.backupCodes = await Promise.all(backupCodes.map((c) => bcrypt.hash(c, 10)));
  user.twoFactor.enabled = true;
  user.twoFactor.enabledAt = new Date();
  await user.save();

  logger.info("2FA enabled", { userId: user.id });
  res.json({
    message: "Two-factor authentication enabled.",
    backupCodes, // shown exactly once — only hashes are stored
  });
}

/** POST /user/2fa/disable — requires the password AND a current code/backup code. */
export async function disable(req: Request, res: Response): Promise<void> {
  const { password, code } = req.body as { password?: string; code?: string };
  if (!password || !code) throw HttpError.badRequest("Password and a verification code are required.");

  const user = await User.findById(req.payload!.id).select("+password +twoFactor");
  if (!user) throw HttpError.notFound("User not found.");
  if (!user.twoFactor?.enabled)
    throw HttpError.badRequest("Two-factor authentication is not enabled.", "2fa_not_enabled");

  if (!(await bcrypt.compare(password, user.password)))
    throw HttpError.unauthorized("Password is incorrect.", "bad_credentials");

  const codeOk =
    (await verifyTotp(user.twoFactor.secret, code)) || (await consumeBackupCode(user.twoFactor, code));
  if (!codeOk) throw HttpError.unauthorized("That code didn't match.", "2fa_bad_code");

  user.twoFactor = undefined;
  await user.save();
  logger.info("2FA disabled", { userId: user.id });
  res.json({ message: "Two-factor authentication disabled." });
}

/**
 * POST /user/login/2fa — second step of login. The pending token proves the
 * password step; it is useless as an access token (auth middleware rejects
 * scoped tokens). Accepts a TOTP code or a single-use backup code.
 */
export async function completeLogin(req: Request, res: Response): Promise<void> {
  const { pendingToken, code } = req.body as { pendingToken?: string; code?: string };
  if (!pendingToken || !code) throw HttpError.badRequest("pendingToken and code are required.");

  let userId: string;
  try {
    userId = verify2faPendingToken(pendingToken);
  } catch {
    throw HttpError.unauthorized("Sign-in expired — enter your password again.", "2fa_pending_invalid");
  }

  const user = await User.findById(userId).select("+twoFactor");
  if (!user?.twoFactor?.enabled)
    throw HttpError.unauthorized("Two-factor sign-in is not available for this account.", "2fa_not_enabled");

  let usedBackupCode = false;
  if (!(await verifyTotp(user.twoFactor.secret, code))) {
    usedBackupCode = await consumeBackupCode(user.twoFactor, code);
    if (!usedBackupCode) throw HttpError.unauthorized("That code didn't match.", "2fa_bad_code");
  }

  const token = signToken({ id: user.id });
  await issueRefreshToken(res, user.id, req.ip);
  user.isOnline = true;
  await user.save(); // also persists the burned backup code
  logger.info("User logged in (2FA)", { userId: user.id, usedBackupCode });

  res.json({
    message: "User logged in successfully!",
    token,
    userName: user.name,
    user: { id: user.id, name: user.name, email: user.email, dp: user.dp || "", bio: user.bio || "" },
    ...(usedBackupCode ? { backupCodesLeft: user.twoFactor.backupCodes.length } : {}),
  });
}
