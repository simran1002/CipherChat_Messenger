import type { IPresenceRegistry, OnlineUserInfo, OnlineUserPublic } from "./interfaces.js";

/**
 * In-memory roster of online users (userId → connection + presence info).
 * This is deliberately the ONLY place that knows who is online — server.ts
 * used to own a raw Map, which was the main single-node bottleneck.
 * Redis swap (Phase 2): HSET online:{userId} + per-user socket rooms.
 */
export class PresenceRegistry implements IPresenceRegistry {
  private readonly users = new Map<string, OnlineUserInfo>();

  async set(userId: string, info: OnlineUserInfo): Promise<void> {
    this.users.set(userId, info);
  }

  async get(userId: string): Promise<OnlineUserInfo | undefined> {
    return this.users.get(userId);
  }

  async update(userId: string, patch: Partial<OnlineUserInfo>): Promise<boolean> {
    const existing = this.users.get(userId);
    if (!existing) return false;
    this.users.set(userId, { ...existing, ...patch });
    return true;
  }

  async delete(userId: string): Promise<void> {
    this.users.delete(userId);
  }

  async list(): Promise<OnlineUserPublic[]> {
    return Array.from(this.users.entries()).map(([userId, u]) => ({
      userId,
      name: u.name,
      dp: u.dp,
      presenceStatus: u.presenceStatus || "available",
      presenceNote: u.presenceNote || "",
    }));
  }
}
