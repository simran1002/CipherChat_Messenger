import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import auth, { signToken, verifyToken } from "../../src/middlewares/auth.js";
import { env } from "../../src/config/env.js";

function b64url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

describe("auth middleware — token functions", () => {
  it("signToken/verifyToken round-trip preserves the id", () => {
    const token = signToken({ id: "user-abc-123" });
    expect(verifyToken(token)).toEqual({ id: "user-abc-123" });
  });

  it("rejects a token signed with a different secret", () => {
    const forged = jwt.sign({ id: "attacker" }, "some-other-secret-that-is-32-chars!!", {
      algorithm: "HS256",
    });
    expect(() => verifyToken(forged)).toThrow();
  });

  it("rejects an alg:none token (algorithm confusion attack)", () => {
    // Hand-crafted unsigned token: header.payload. with an empty signature
    const noneToken = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ id: "attacker" })}.`;
    expect(() => verifyToken(noneToken)).toThrow();
  });

  it("rejects a well-signed token whose payload has no string id", () => {
    const token = jwt.sign({ sub: "no-id-claim" }, env.SECRET, { algorithm: "HS256" });
    expect(() => verifyToken(token)).toThrow(/malformed token payload/i);
  });
});

describe("auth middleware — express integration", () => {
  let server: HttpServer;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.get("/protected", auth, (req, res) => {
      res.json({ id: req.payload!.id });
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("passes a valid Bearer token through and exposes req.payload", async () => {
    const token = signToken({ id: "user-1" });
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "user-1" });
  });

  it("401s when the Authorization header is missing", async () => {
    const res = await fetch(`${baseUrl}/protected`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Authentication required", code: "unauthorized" });
  });

  it("401s on a non-Bearer scheme", async () => {
    const token = signToken({ id: "user-1" });
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { authorization: `Token ${token}` },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Authentication required", code: "unauthorized" });
  });

  it("401s with code token_expired for an expired token", async () => {
    const expired = jwt.sign({ id: "user-1" }, env.SECRET, {
      algorithm: "HS256",
      expiresIn: -1, // already expired at issue time
    });
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Token expired", code: "token_expired" });
  });

  it("401s with code token_invalid for garbage tokens", async () => {
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { authorization: "Bearer not.a.token" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Invalid token", code: "token_invalid" });
  });
});
