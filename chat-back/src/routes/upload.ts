import { Router } from "express";
import auth from "../middlewares/auth.js";
import upload from "../middlewares/upload.js";
import { HttpError } from "../errors/HttpError.js";
import { logger } from "../utils/logger.js";

const router = Router();

// POST /upload — single file, returns { url, fileName, mimeType, fileSize }
router.post("/", auth, upload.single("file"), (req, res) => {
  if (!req.file) throw HttpError.badRequest("No file uploaded.", "no_file");
  const url = `/uploads/${req.file.filename}`;
  logger.info("File uploaded", { filename: req.file.filename, user: req.payload!.id });
  res.json({
    url,
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
    fileSize: req.file.size,
  });
});

export default router;
