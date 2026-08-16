/**
 * Runs before every test suite (vitest setupFiles).
 * src/config/env.ts validates process.env at import time, so these must be
 * set before any src module is imported. The DATABASE value is a placeholder —
 * suites connect mongoose to their own MongoMemoryServer URI directly.
 */
process.env.DATABASE = process.env.DATABASE || "mongodb://127.0.0.1:27017/placeholder-not-used";
process.env.SECRET = "test-secret-key-that-is-at-least-32-chars-long";
process.env.ENV = "TEST";
process.env.LOG_LEVEL = "error";
