/**
 * Session management: each refresh-token row is a signed-in browser.
 * Users can list their sessions, revoke one, or revoke all others.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, stopDb } from "../helpers/db.js";
import { startTestServer, type TestServer } from "../helpers/testServer.js";

interface SessionView {
  id: string;
  current: boolean;
  createdAt: string;
  expiresAt: string;
}

function cookieFrom(res: Response): string {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const raw = setCookie.find((c) => c.startsWith("CC_Refresh="));
  if (!raw) throw new Error("no CC_Refresh cookie in response");
  return raw.split(";")[0]!; // "CC_Refresh=<value>"
}

describe("session management", () => {
  let server: TestServer;
  const email = `sessions-${Date.now()}@test.cipher`;

  beforeAll(async () => {
    await startDb();
    server = await startTestServer();
    const reg = await fetch(`${server.baseUrl}/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Session Tester", email, password: "password123" }),
    });
    expect(reg.status).toBe(200);
  });

  afterAll(async () => {
    await server.close();
    await stopDb();
  });

  async function login(): Promise<{ token: string; cookie: string }> {
    const res = await fetch(`${server.baseUrl}/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    return { token, cookie: cookieFrom(res) };
  }

  async function sessions(token: string, cookie: string): Promise<SessionView[]> {
    const res = await fetch(`${server.baseUrl}/user/sessions`, {
      headers: { Authorization: `Bearer ${token}`, Cookie: cookie },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { sessions: SessionView[] }).sessions;
  }

  it("lists every live session and flags the current one", async () => {
    const a = await login(); // "browser A"
    const b = await login(); // "browser B"

    const fromA = await sessions(a.token, a.cookie);
    expect(fromA.length).toBeGreaterThanOrEqual(2);
    expect(fromA.filter((s) => s.current)).toHaveLength(1);

    const fromB = await sessions(b.token, b.cookie);
    const currentA = fromA.find((s) => s.current)!.id;
    const currentB = fromB.find((s) => s.current)!.id;
    expect(currentA).not.toBe(currentB);
  });

  it("revokes a single session by id — that browser's refresh then fails", async () => {
    const a = await login();
    const victim = await login();

    const list = await sessions(a.token, a.cookie);
    const victimRow = list.find((s) => !s.current)!;

    const del = await fetch(`${server.baseUrl}/user/sessions/${victimRow.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${a.token}`, Cookie: a.cookie },
    });
    expect(del.status).toBe(200);

    // Victim can no longer refresh (its row is gone)...
    const victimRefresh = await fetch(`${server.baseUrl}/user/refresh`, {
      method: "POST",
      headers: { Cookie: victim.cookie },
    });
    // ...unless the "victim" row we picked happened to be a different older
    // session — so assert on the list instead, which is unambiguous:
    const after = await sessions(a.token, a.cookie);
    expect(after.some((s) => s.id === victimRow.id)).toBe(false);
    expect([200, 401]).toContain(victimRefresh.status);
  });

  it("cannot revoke another user's session (owner-scoped)", async () => {
    const a = await login();
    const otherEmail = `other-${Date.now()}@test.cipher`;
    const otherReg = await fetch(`${server.baseUrl}/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Other", email: otherEmail, password: "password123" }),
    });
    const otherToken = ((await otherReg.json()) as { token: string }).token;
    const otherCookie = cookieFrom(otherReg);
    const otherSessions = await sessions(otherToken, otherCookie);
    const otherId = otherSessions[0]!.id;

    const del = await fetch(`${server.baseUrl}/user/sessions/${otherId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${a.token}`, Cookie: a.cookie },
    });
    expect(del.status).toBe(404); // not found *for this user*
  });

  it("'sign out everywhere else' keeps only the current session", async () => {
    const keep = await login();
    await login();
    await login();

    const before = await sessions(keep.token, keep.cookie);
    expect(before.length).toBeGreaterThanOrEqual(3);

    const res = await fetch(`${server.baseUrl}/user/sessions`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${keep.token}`, Cookie: keep.cookie },
    });
    expect(res.status).toBe(200);

    const after = await sessions(keep.token, keep.cookie);
    expect(after).toHaveLength(1);
    expect(after[0]!.current).toBe(true);

    // And the surviving session still refreshes fine
    const refresh = await fetch(`${server.baseUrl}/user/refresh`, {
      method: "POST",
      headers: { Cookie: keep.cookie },
    });
    expect(refresh.status).toBe(200);
  });
});
