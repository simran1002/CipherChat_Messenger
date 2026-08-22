import multer from "multer";
import { HttpError } from "../errors/HttpError.js";

/**
 * Multer receives the multipart body into memory; the storage driver
 * (src/storage) decides where bytes actually live. Memory is fine at the
 * 10 MB cap — the alternative (disk temp files) would couple this layer to
 * the local driver again.
 */
const ALLOWED_MIME = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/wav",
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const fileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  if (ALLOWED_MIME.includes(file.mimetype)) cb(null, true);
  else cb(new HttpError(415, "unsupported_media_type", "File type not allowed"));
};

export const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

export default upload;
