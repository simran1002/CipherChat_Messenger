import { Redis } from "ioredis";
import { env } from "./env.js";
import { logger } from "../utils/logger.js";

/**
 * Redis is optional: without REDIS_URL the app runs single-node on the
 * in-memory implementations (local dev, unit tests). With it, every piece of
 * coordination state moves to Redis and the app can scale horizontally.
 */
export const redisEnabled = Boolean(env.REDIS_URL);

let client: Redis | null = null;

/** Shared command client (lazily created). */
export function getRedis(): Redis {
  if (!env.REDIS_URL) throw new Error("REDIS_URL is not configured");
  if (!client) {
    client = createRedisConnection("main");
  }
  return client;
}

/** Dedicated connection (the socket.io adapter needs its own pub/sub pair). */
export function createRedisConnection(label: string): Redis {
  const conn = new Redis(env.REDIS_URL!, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    lazyConnect: false,
  });
  conn.on("error", (err) => logger.error("Redis error", { label, error: err.message }));
  conn.on("connect", () => logger.info("Redis connected", { label }));
  return conn;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => {});
    client = null;
  }
}
