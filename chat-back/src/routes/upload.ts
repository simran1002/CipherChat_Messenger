import { Router } from "express";
import multer from "multer";
import auth from "../middlewares/auth.js";
import upload from "../middlewares/upload.js";
import { catchErrors } from "../middlewares/errorHandlers.js";
import { HttpError } from "../errors/HttpError.js";
import { fileStorage } from "../storage/index.js";
import { logger } from "../utils/logger.js";

const router = Router();

// POST /upload — single file, returns { url, fileName, mimeType, fileSize }
router.post(
  "/",
  auth,
  upload.single("file"),
  catchErrors(async (req, res) => {
    if (!req.file) throw HttpError.badRequest("No file uploaded.", "no_file");
    const stored = await fileStorage.put(req.file);
    logger.info("File uploaded", {
      key: stored.key,
      driver: fileStorage.driver,
      user: req.payload!.id,
    });
    res.json({
      url: stored.url,
      fileName: stored.fileName,
      mimeType: stored.mimeType,
      fileSize: stored.fileSize,
    });
  })
);

// ── Encrypted blobs (E2EE DM attachments) ────────────────────────────────────
// The client encrypts the file with AES-256-GCM BEFORE upload; the key/IV and
// real metadata (name, MIME, size) travel only inside the E2EE envelope. The
// server stores an opaque application/octet-stream blob and cannot learn what
// it is — deliberately a separate route so the plaintext /upload keeps its
// strict MIME allowlist for room attachments.
// plaintext cap (10 MB) + GCM tag + slack
const MAX_ENCRYPTED_BYTES = 10 * 1024 * 1024 + 64 * 1024;

const encryptedUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/octet-stream") cb(null, true);
    else cb(new HttpError(415, "unsupported_media_type", "Encrypted uploads must be application/octet-stream"));
  },
  limits: { fileSize: MAX_ENCRYPTED_BYTES },
});

router.post(
  "/encrypted",
  auth,
  encryptedUpload.single("file"),
  catchErrors(async (req, res) => {
    if (!req.file) throw HttpError.badRequest("No file uploaded.", "no_file");
    const stored = await fileStorage.put({
      ...req.file,
      // never trust/echo a client-supplied name for opaque blobs
      originalname: "encrypted.bin",
    });
    logger.info("Encrypted blob uploaded", {
      key: stored.key,
      driver: fileStorage.driver,
      user: req.payload!.id,
      bytes: stored.fileSize,
    });
    res.json({ url: stored.url, fileSize: stored.fileSize });
  })
);

// POST /upload/encrypted/presign — direct-to-bucket variant. Returns a
// short-lived PUT URL so the ciphertext never transits the app server
// (object storage drivers only; local disk answers 501 and the client
// falls back to the proxied POST /upload/encrypted above). The signature
// pins content type AND length, so the size cap holds bucket-side too.
router.post(
  "/encrypted/presign",
  auth,
  catchErrors(async (req, res) => {
    const size = Number((req.body as { size?: unknown })?.size);
    if (!Number.isInteger(size) || size <= 0 || size > MAX_ENCRYPTED_BYTES) {
      throw HttpError.badRequest("size must be a positive integer within the upload cap.", "invalid_size");
    }
    if (!fileStorage.presignPut) {
      throw new HttpError(501, "presign_unsupported", "Direct uploads need object storage (STORAGE_DRIVER=s3).");
    }
    const presigned = await fileStorage.presignPut({
      contentType: "application/octet-stream",
      contentLength: size,
    });
    logger.info("Encrypted blob presigned", {
      key: presigned.key,
      user: req.payload!.id,
      bytes: size,
    });
    res.json({
      uploadUrl: presigned.uploadUrl,
      headers: presigned.headers,
      url: presigned.url,
      expiresSeconds: presigned.expiresSeconds,
    });
  })
);

export default router;
