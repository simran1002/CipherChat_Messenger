import type { Redis } from "ioredis";
import type { IPresenceRegistry, OnlineUserInfo, OnlineUserPublic } from "../interfaces.js";

/**
 * Cluster-wide online roster in Redis.
 *
 * Layout:
 *   online:{userId}  HASH of OnlineUserInfo fields, EX presenceTtl
 *   online_index     SET of userIds (membership check + roster listing)
 *
 * The per-key TTL is a safety net: if a replica dies without running its
 * disconnect handlers, the hash expires and the user drops off the roster
 * within presenceTtl (list() prunes index entries whose hash is gone).
 *
 * Cross-pod message targeting does NOT use socketId from here — sockets join
 * a per-user room (user:{id}) and emits go through the Redis adapter.
 */
export class RedisPresenceRegistry implements IPresenceRegistry {
  constructor(
    private readonly redis: Redis,
    private readonly presenceTtlSeconds = 90
  ) {}

  private key(userId: string): string {
    return `online:${userId}`;
  }

  async set(userId: string, info: OnlineUserInfo): Promise<void> {
    const multi = this.redis.multi();
    multi.hset(this.key(userId), { ...info });
    multi.expire(this.key(userId), this.presenceTtlSeconds);
    multi.sadd("online_index", userId);
    await multi.exec();
  }

  async get(userId: string): Promise<OnlineUserInfo | undefined> {
    const data = await this.redis.hgetall(this.key(userId));
    if (!data || Object.keys(data).length === 0) return undefined;
    return data as unknown as OnlineUserInfo;
  }

  async update(userId: string, patch: Partial<OnlineUserInfo>): Promise<boolean> {
    const exists = await this.redis.exists(this.key(userId));
    if (!exists) return false;
    const multi = this.redis.multi();
    multi.hset(this.key(userId), { ...patch });
    multi.expire(this.key(userId), this.presenceTtlSeconds);
    await multi.exec();
    return true;
  }

  /** Called from the heartbeat path — refreshes the safety-net TTL. */
  async touch(userId: string): Promise<void> {
    await this.redis.expire(this.key(userId), this.presenceTtlSeconds);
  }

  async delete(userId: string): Promise<void> {
    const multi = this.redis.multi();
    multi.del(this.key(userId));
    multi.srem("online_index", userId);
    await multi.exec();
  }

  async list(): Promise<OnlineUserPublic[]> {
    const ids = await this.redis.smembers("online_index");
    if (!ids.length) return [];

    const pipeline = this.redis.pipeline();
    ids.forEach((id) => pipeline.hgetall(this.key(id)));
    const rows = (await pipeline.exec()) ?? [];

    const out: OnlineUserPublic[] = [];
    const stale: string[] = [];
    rows.forEach(([, data], i) => {
      const info = data as Record<string, string> | null;
      const userId = ids[i]!;
      if (info && Object.keys(info).length > 0) {
        out.push({
          userId,
          name: info.name ?? "",
          dp: info.dp ?? "",
          presenceStatus: info.presenceStatus || "available",
          presenceNote: info.presenceNote || "",
        });
      } else {
        stale.push(userId); // hash expired but index entry lingered
      }
    });
    if (stale.length) await this.redis.srem("online_index", ...stale);
    return out;
  }
}
