/**
 * TOTP two-factor authentication — full lifecycle over HTTP:
 * setup → enable (live code) → two-step login → backup codes → disable.
 * Codes are generated with the same otplib the server verifies with, from
 * the secret the setup endpoint returns.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate } from "otplib";
import { startDb, stopDb } from "../helpers/db.js";
import { startTestServer, type TestServer } from "../helpers/testServer.js";

const EMAIL = "twofactor@test.cipher";
const PASSWORD = "correct-horse-battery";

describe("two-factor authentication", () => {
  let server: TestServer;
  let accessToken: string;
  let totpSecret: string;
  let backupCodes: string[];

  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  const passwordLogin = () => post("/user/login", { email: EMAIL, password: PASSWORD });

  beforeAll(async () => {
    await startDb();
    server = await startTestServer();
    const res = await post("/user/register", { name: "Two Factor", email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    accessToken = ((await res.json()) as { token: string }).token;
  });

  afterAll(async () => {
    await server.close();
    await stopDb();
  });

  it("setup returns an otpauth URI; enable rejects a wrong code", async () => {
    const setup = await post("/user/2fa/setup", {}, accessToken);
    expect(setup.status).toBe(200);
    const body = (await setup.json()) as { otpauthUrl: string; secret: string };
    expect(body.otpauthUrl).toContain("otpauth://totp/");
    expect(body.otpauthUrl).toContain("issuer=CipherChat");
    totpSecret = body.secret;

    const bad = await post("/user/2fa/enable", { code: "000000" }, accessToken);
    expect(bad.status).toBe(401);
    // A failed confirmation must not half-enable anything
    const login = await passwordLogin();
    expect(((await login.json()) as { requires2fa?: boolean }).requires2fa).toBeUndefined();
  });

  it("enable with a live code activates 2FA and returns single-use backup codes", async () => {
    const code = await generate({ secret: totpSecret });
    const res = await post("/user/2fa/enable", { code }, accessToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backupCodes: string[] };
    expect(body.backupCodes).toHaveLength(8);
    expect(body.backupCodes[0]).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    backupCodes = body.backupCodes;
  });

  it("login now returns a pending token instead of a session", async () => {
    const res = await passwordLogin();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requires2fa?: boolean; pendingToken?: string; token?: string };
    expect(body.requires2fa).toBe(true);
    expect(typeof body.pendingToken).toBe("string");
    expect(body.token).toBeUndefined(); // no access token from the password alone
    expect(res.headers.get("set-cookie")).toBeNull(); // and no refresh cookie

    // The pending token must be worthless as an access token
    const probe = await fetch(`${server.baseUrl}/user/profile`, {
      headers: { Authorization: `Bearer ${body.pendingToken}` },
    });
    expect(probe.status).toBe(401);

    // Wrong code → still no session
    const wrong = await post("/user/login/2fa", { pendingToken: body.pendingToken, code: "123456" });
    expect(wrong.status).toBe(401);

    // Right code → real session
    const code = await generate({ secret: totpSecret });
    const ok = await post("/user/login/2fa", { pendingToken: body.pendingToken, code });
    expect(ok.status).toBe(200);
    const session = (await ok.json()) as { token: string };
    const me = await fetch(`${server.baseUrl}/user/profile`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    expect(me.status).toBe(200);
  });

  it("a garbage pending token is rejected outright", async () => {
    const res = await post("/user/login/2fa", { pendingToken: accessToken, code: "123456" });
    expect(res.status).toBe(401); // an access token is NOT a pending token either
  });

  it("backup codes work exactly once", async () => {
    const { pendingToken } = (await (await passwordLogin()).json()) as { pendingToken: string };
    const burn = await post("/user/login/2fa", { pendingToken, code: backupCodes[0] });
    expect(burn.status).toBe(200);
    expect(((await burn.json()) as { backupCodesLeft: number }).backupCodesLeft).toBe(7);

    const { pendingToken: again } = (await (await passwordLogin()).json()) as { pendingToken: string };
    const reuse = await post("/user/login/2fa", { pendingToken: again, code: backupCodes[0] });
    expect(reuse.status).toBe(401); // burned
  });

  it("disable requires password + code, then login is single-step again", async () => {
    const noCode = await post("/user/2fa/disable", { password: PASSWORD, code: "000000" }, accessToken);
    expect(noCode.status).toBe(401);
    const noPass = await post(
      "/user/2fa/disable",
      { password: "wrong", code: await generate({ secret: totpSecret }) },
      accessToken
    );
    expect(noPass.status).toBe(401);

    const ok = await post(
      "/user/2fa/disable",
      { password: PASSWORD, code: await generate({ secret: totpSecret }) },
      accessToken
    );
    expect(ok.status).toBe(200);

    const login = await passwordLogin();
    const body = (await login.json()) as { token?: string; requires2fa?: boolean };
    expect(body.requires2fa).toBeUndefined();
    expect(typeof body.token).toBe("string");
  });
});
