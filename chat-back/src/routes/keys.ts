import { Router } from "express";
import { ed25519 } from "@noble/curves/ed25519.js";
import auth from "../middlewares/auth.js";
import { catchErrors } from "../middlewares/errorHandlers.js";
import { HttpError } from "../errors/HttpError.js";
import { User } from "../models/User.js";
import { logger } from "../utils/logger.js";
import mongoose from "mongoose";

const router = Router();

function b64(s: unknown, maxLen = 128): Uint8Array {
  if (typeof s !== "string" || !s || s.length > maxLen) throw HttpError.badRequest("Malformed key material.");
  try {
    return Uint8Array.from(Buffer.from(s, "base64"));
  } catch {
    throw HttpError.badRequest("Malformed key material.");
  }
}

/**
 * PUT /keys — publish (or replace) the caller's public key bundle.
 * The server's one crypto responsibility: verify the prekey is signed by the
 * identity key, so the directory can't serve a mix-and-match bundle.
 * Republishing with a different identity bumps keyVersion (reset detection).
 */
router.put(
  "/",
  auth,
  catchErrors(async (req, res) => {
    const { identityEd25519, identityX25519, signedPreKey } = req.body as {
      identityEd25519?: string;
      identityX25519?: string;
      signedPreKey?: { keyId?: number; pubX25519?: string; sig?: string };
    };

    const edPub = b64(identityEd25519);
    const xPub = b64(identityX25519);
    if (edPub.length !== 32 || xPub.length !== 32) throw HttpError.badRequest("Keys must be 32 bytes.");
    if (!signedPreKey || typeof signedPreKey.keyId !== "number")
      throw HttpError.badRequest("signedPreKey required.");
    const spkPub = b64(signedPreKey.pubX25519);
    const sig = b64(signedPreKey.sig);
    if (spkPub.length !== 32 || sig.length !== 64) throw HttpError.badRequest("Malformed prekey.");

    let sigOk = false;
    try {
      sigOk = ed25519.verify(sig, spkPub, edPub);
    } catch {
      sigOk = false;
    }
    if (!sigOk) throw HttpError.badRequest("Prekey signature invalid.", "bad_prekey_signature");

    const user = await User.findById(req.payload!.id);
    if (!user) throw HttpError.notFound("User not found.");

    const identityChanged = user.keys != null && user.keys.identityEd25519 !== identityEd25519;

    user.keys = {
      identityEd25519: identityEd25519!,
      identityX25519: identityX25519!,
      signedPreKey: {
        keyId: signedPreKey.keyId,
        pubX25519: signedPreKey.pubX25519!,
        sig: signedPreKey.sig!,
      },
      keyVersion: identityChanged ? user.keys!.keyVersion + 1 : (user.keys?.keyVersion ?? 1),
      publishedAt: new Date(),
    } as typeof user.keys;
    await user.save();

    logger.info("Key bundle published", {
      userId: user.id,
      keyVersion: user.keys!.keyVersion,
      identityChanged,
    });
    res.json({ keyVersion: user.keys!.keyVersion });
  })
);

/** GET /keys/me — the caller's own published bundle (null when none). */
router.get(
  "/me",
  auth,
  catchErrors(async (req, res) => {
    const user = await User.findById(req.payload!.id).select("keys");
    res.json({ keys: user?.keys ?? null });
  })
);

/** GET /keys/:userId — a peer's public bundle, for session establishment. */
router.get(
  "/:userId",
  auth,
  catchErrors(async (req, res) => {
    const { userId } = req.params as { userId: string };
    if (!mongoose.Types.ObjectId.isValid(userId)) throw HttpError.badRequest("Invalid user ID.");
    const user = await User.findById(userId).select("keys name");
    if (!user) throw HttpError.notFound("User not found.");
    if (!user.keys) throw HttpError.notFound("User has not published keys.", "no_keys");
    res.json({ userId, keys: user.keys });
  })
);

/**
 * PUT /keys/backup — store the opaque, client-encrypted backup blob.
 * GET /keys/backup — retrieve it (restore-on-new-browser flow).
 */
router.put(
  "/backup/blob",
  auth,
  catchErrors(async (req, res) => {
    const { blob } = req.body as { blob?: string };
    if (typeof blob !== "string" || !blob || blob.length > 128 * 1024)
      throw HttpError.badRequest("Backup blob missing or too large.");
    await User.updateOne({ _id: req.payload!.id }, { keyBackup: blob });
    res.json({ ok: true });
  })
);

router.get(
  "/backup/blob",
  auth,
  catchErrors(async (req, res) => {
    const user = await User.findById(req.payload!.id).select("+keyBackup");
    if (!user?.keyBackup) throw HttpError.notFound("No backup stored.", "no_backup");
    res.json({ blob: user.keyBackup });
  })
);

export default router;
