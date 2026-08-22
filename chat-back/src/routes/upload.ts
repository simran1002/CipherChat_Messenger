import { Router } from "express";
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

export default router;
