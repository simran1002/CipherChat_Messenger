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
  FRONTEND_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
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
