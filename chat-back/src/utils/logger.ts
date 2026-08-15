import { env } from "../config/env.js";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;

type Level = keyof typeof LEVELS;

const currentLevel = LEVELS[env.LOG_LEVEL];

function log(level: Level, msg: string, data: Record<string, unknown> = {}): void {
  if (LEVELS[level] > currentLevel) return;
  const entry = { level, time: new Date().toISOString(), msg, ...data };
  (level === "error" ? console.error : console.log)(JSON.stringify(entry));
}

export const logger = {
  info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
  debug: (msg: string, data?: Record<string, unknown>) => log("debug", msg, data),
};

/** Extract a safe message string from an unknown thrown value. */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
