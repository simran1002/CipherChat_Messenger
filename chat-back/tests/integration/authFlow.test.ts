import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, stopDb } from "../helpers/db.js";
import { startTestServer, type TestServer } from "../helpers/testServer.js";

interface AuthResponse {
  message?: string;
  token?: string;
  user?: { id: string; name: string; email: string };
  code?: string;
}

/** Pull the raw CC_Refresh Set-Cookie line off a response (or null). */
function refreshCookieLine(res: Response): string | null {
  return res.headers.getSetCookie().find((c) => c.startsWith("CC_Refresh=")) ?? null;
}

/** Extract just the cookie value from the raw Set-Cookie line. */
function refreshCookieValue(res: Response): string | null {
  const line = refreshCookieLine(res);
  if (!line) return null;
  return line.slice("CC_Refresh=".length).split(";")[0] ?? null;
}

describe("auth flow (REST integration)", () => {
  let server: TestServer;
  let userCounter = 0;

  beforeAll(async () => {
    await startDb();
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
    await stopDb();
  });

  function uniqueEmail(): string {
    return `authflow${++userCounter}-${Date.now()}@test.cipher`;
  }

  async function registerUser(email: string, password = "password123"): Promise<Response> {
    return fetch(`${server.baseUrl}/user/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Auth Flow User", email, password }),
    });
  }

  async function refreshWith(cookieValue: string): Promise<Response> {
    return fetch(`${server.baseUrl}/user/refresh`, {
      method: "POST",
      headers: { cookie: `CC_Refresh=${cookieValue}` },
    });
  }

  it("registers a new user: 200 with token and user", async () => {
    const res = await registerUser(uniqueEmail());
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuthResponse;
    expect(body.token).toBeTruthy();
    expect(body.user?.id).toBeTruthy();
    expect(body.user?.name).toBe("Auth Flow User");
  });

  it("rejects a duplicate email with 409", async () => {
    const email = uniqueEmail();
    expect((await registerUser(email)).status).toBe(200);

    const dup = await registerUser(email);
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as AuthResponse).code).toBe("email_taken");
  });

  it("rejects login with the wrong password: 401", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const res = await fetch(`${server.baseUrl}/user/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "wrong-password" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as AuthResponse).code).toBe("bad_credentials");
  });

  it("login sets an httpOnly CC_Refresh cookie", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const res = await fetch(`${server.baseUrl}/user/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    expect(res.status).toBe(200);

    const cookieLine = refreshCookieLine(res);
    expect(cookieLine).toBeTruthy();
    expect(cookieLine!).toMatch(/httponly/i);
    expect(refreshCookieValue(res)).toBeTruthy();
  });

  it("refresh rotates the cookie and invalidates the old one", async () => {
    const registered = await registerUser(uniqueEmail());
    const oldCookie = refreshCookieValue(registered);
    expect(oldCookie).toBeTruthy();

    // Rotate: old cookie → 200 + new access token + new cookie
    const first = await refreshWith(oldCookie!);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as AuthResponse;
    expect(firstBody.token).toBeTruthy();

    const newCookie = refreshCookieValue(first);
    expect(newCookie).toBeTruthy();
    expect(newCookie).not.toBe(oldCookie);

    // Replaying the OLD cookie after rotation must fail (theft detection)
    const replay = await refreshWith(oldCookie!);
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as AuthResponse).code).toBe("refresh_invalid");

    // The rotated cookie is still good
    const second = await refreshWith(newCookie!);
    expect(second.status).toBe(200);
  });

  it("logout revokes the refresh token — subsequent refresh 401s", async () => {
    const registered = await registerUser(uniqueEmail());
    const cookie = refreshCookieValue(registered);
    expect(cookie).toBeTruthy();

    const logout = await fetch(`${server.baseUrl}/user/logout`, {
      method: "POST",
      headers: { cookie: `CC_Refresh=${cookie}` },
    });
    expect(logout.status).toBe(200);

    const res = await refreshWith(cookie!);
    expect(res.status).toBe(401);
  });

  it("refresh without any cookie 401s", async () => {
    const res = await fetch(`${server.baseUrl}/user/refresh`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});
