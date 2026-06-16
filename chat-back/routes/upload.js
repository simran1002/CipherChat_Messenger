const router = require("express").Router();
const path = require("path");
const auth = require("../middlewares/auth");
const upload = require("../middlewares/upload");
const logger = require("../utils/logger");

// POST /upload — single file, returns { url, fileName, mimeType, fileSize }
router.post("/", auth, upload.single("file"), (req, res) => {
  if (!req.file) throw "No file uploaded.";
  const url = `/uploads/${req.file.filename}`;
  logger.info("File uploaded", { filename: req.file.filename, user: req.payload.id });
  res.json({
    url,
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
    fileSize: req.file.size,
  });
});

module.exports = router;
