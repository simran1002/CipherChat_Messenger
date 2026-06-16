const logger = require("./logger");

const REQUIRED = ["DATABASE", "SECRET"];

module.exports = function validateEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    logger.error("Missing required environment variables — shutting down", { missing });
    process.exit(1);
  }
  if (process.env.SECRET && process.env.SECRET.length < 32) {
    logger.warn("SECRET is shorter than 32 characters — use a long random string in production");
  }
};
