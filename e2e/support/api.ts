import { randomUUID } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";

export const WEB = process.env.E2E_WEB_URL ?? "http://localhost:3000";
export const API = process.env.E2E_API_URL ?? "http://localhost:8080";
export const PASSWORD = "correct horse battery staple";

export interface Account {
  id: string;
  name: string;
  email: string;
  token: string;
  /** "CC_Refresh=<value>" exactly as the server set it — replayable as a Cookie header. */
  refreshCookie: string;
}

/** Short unique suffix so parallel workers and repeated runs never collide on names or emails. */
export const uid = (): string => randomUUID().replace(/-/g, "").slice(0, 8);

export const uniqueEmail = (tag: string): string => `${tag}-${uid()}@e2e.test`;

export function bearer(a: Pick<Account, "token">): Record<string, string> {
  return { Authorization: `Bearer ${a.token}` };
}

/** Every Set-Cookie header of a response (Playwright exposes them individually only via headersArray). */
export function setCookies(res: APIResponse): string[] {
  return res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
}

/** The "name=value" pair of one cookie out of a response's Set-Cookie headers. */
export function cookiePair(res: APIResponse, name: string): string | undefined {
  return setCookies(res).map((c) => c.split(";", 1)[0]!).find((c) => c.startsWith(`${name}=`));
}

export async function registerApi(request: APIRequestContext, tag: string): Promise<Account> {
  const name = `${tag} ${uid()}`;
  const email = uniqueEmail(tag.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const res = await request.post(`${API}/api/v1/auth/register`, { data: { name, email, password: PASSWORD } });
  if (res.status() !== 201) throw new Error(`register failed: ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as { token: string; user: { id: string } };
  const refreshCookie = cookiePair(res, "CC_Refresh");
  if (!refreshCookie) throw new Error("register did not set the refresh cookie");
  return { id: body.user.id, name, email, token: body.token, refreshCookie };
}

export async function createRoom(request: APIRequestContext, owner: Account, isPrivate = false): Promise<string> {
  const res = await request.post(`${API}/api/v1/chatrooms`, {
    headers: bearer(owner),
    data: { name: `e2e-${uid()}`, isPrivate },
  });
  if (res.status() !== 201) throw new Error(`createRoom failed: ${res.status()} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

export async function joinRoom(request: APIRequestContext, who: Account, roomId: string): Promise<void> {
  const res = await request.post(`${API}/api/v1/chatrooms/${roomId}/join`, { headers: bearer(who) });
  if (!res.ok()) throw new Error(`join failed: ${res.status()} ${await res.text()}`);
}

export interface SendResult {
  status: number;
  body: { messageId?: string; sequenceNumber?: number; duplicate?: boolean; message?: string; code?: string };
}

export async function sendRoomMessage(
  request: APIRequestContext,
  who: Account,
  roomId: string,
  message: string,
  clientMessageId: string = randomUUID(),
): Promise<SendResult> {
  const res = await request.post(`${API}/api/v1/chatrooms/${roomId}/messages`, {
    headers: bearer(who),
    data: { message, clientMessageId },
  });
  return { status: res.status(), body: (await res.json()) as SendResult["body"] };
}

export async function roomMessages(request: APIRequestContext, who: Account, roomId: string): Promise<{ message: string; sequenceNumber: number }[]> {
  const res = await request.get(`${API}/api/v1/chatrooms/${roomId}/messages?limit=200`, { headers: bearer(who) });
  if (!res.ok()) throw new Error(`history failed: ${res.status()}`);
  return ((await res.json()) as { messages: { message: string; sequenceNumber: number }[] }).messages;
}
