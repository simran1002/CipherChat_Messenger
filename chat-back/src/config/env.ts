import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  DATABASE: z.string().min(1, "DATABASE (MongoDB URI) is required"),
  SECRET: z.string().min(1, "SECRET (JWT signing key) is required"),
  PORT: z.coerce.number().int().positive().default(8000),
  ENV: z.string().default("production"),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  ANTHROPIC_API_KEY: z.string().optional(),
  /**
   * Anthropic-compatible endpoint for AI features. Point it at a self-hosted
   * gateway (LiteLLM, vLLM behind an adapter, a corporate proxy) so room
   * transcripts never leave the org's infrastructure — the deployment answer
   * to "AI needs plaintext" for the target customer. Omit for api.anthropic.com.
   */
  AI_BASE_URL: z.string().optional(),
  FRONTEND_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  // File storage: "local" (uploads/ on disk) or "s3" (S3-compatible bucket).
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  /** Custom endpoint for MinIO / R2 / LocalStack (omit for AWS). */
  S3_ENDPOINT: z.string().optional(),
  /** Public URL prefix objects are served from (bucket website or CDN). */
  S3_PUBLIC_BASE_URL: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true" || v === "1")),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Logger depends on env, so this one message goes straight to stderr.
  console.error(
    JSON.stringify({
      level: "error",
      time: new Date().toISOString(),
      msg: "Invalid environment — shutting down",
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    })
  );
  process.exit(1);
}

export const env = parsed.data;

if (env.SECRET.length < 32) {
  console.warn(
    JSON.stringify({
      level: "warn",
      time: new Date().toISOString(),
      msg: "SECRET is shorter than 32 characters — use a long random string in production",
    })
  );
}

export const isDevelopment = env.ENV === "DEVELOPMENT";
export const isTest = env.ENV === "TEST";
