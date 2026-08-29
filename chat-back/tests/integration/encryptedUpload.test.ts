/**
 * POST /upload/encrypted — opaque-blob channel for E2EE DM attachments.
 * The server must accept only application/octet-stream, never echo client
 * metadata, and keep the plaintext /upload MIME allowlist intact.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, stopDb } from "../helpers/db.js";
import { createUserWithToken, startTestServer, type TestServer } from "../helpers/testServer.js";

describe("encrypted blob upload", () => {
  let server: TestServer;
  let token: string;

  beforeAll(async () => {
    await startDb();
    server = await startTestServer();
    ({ token } = await createUserWithToken());
  });

  afterAll(async () => {
    await server.close();
    await stopDb();
  });

  function multipart(bytes: Uint8Array, type: string, fileName: string): FormData {
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type }), fileName);
    return fd;
  }

  it("accepts an octet-stream blob and returns only url + size", async () => {
    const payload = new Uint8Array(1024).fill(7);
    const res = await fetch(`${server.baseUrl}/upload/encrypted`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: multipart(payload, "application/octet-stream", "whatever-the-client-said.pdf"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.url).toBe("string");
    expect(body.fileSize).toBe(1024);
    // The claimed client filename must NOT leak into the response
    expect(JSON.stringify(body)).not.toContain("whatever-the-client-said");
  });

  it("rejects non-octet-stream uploads on the encrypted route", async () => {
    const res = await fetch(`${server.baseUrl}/upload/encrypted`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: multipart(new Uint8Array(16), "image/png", "x.png"),
    });
    expect(res.status).toBe(415);
  });

  it("the plaintext /upload route still rejects octet-stream (allowlist intact)", async () => {
    const res = await fetch(`${server.baseUrl}/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: multipart(new Uint8Array(16), "application/octet-stream", "x.bin"),
    });
    expect(res.status).toBe(415);
  });

  it("requires auth", async () => {
    const res = await fetch(`${server.baseUrl}/upload/encrypted`, {
      method: "POST",
      body: multipart(new Uint8Array(16), "application/octet-stream", "x.bin"),
    });
    expect(res.status).toBe(401);
  });

  describe("POST /upload/encrypted/presign", () => {
    async function presign(size: unknown, authToken = token): Promise<Response> {
      return fetch(`${server.baseUrl}/upload/encrypted/presign`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ size }),
      });
    }

    it("answers 501 presign_unsupported on the local-disk driver (client falls back)", async () => {
      const res = await presign(1024);
      expect(res.status).toBe(501);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("presign_unsupported");
    });

    it("rejects invalid sizes with 400 before the driver-capability check", async () => {
      for (const bad of [0, -5, 1.5, "big", null, 11 * 1024 * 1024]) {
        const res = await presign(bad);
        expect(res.status).toBe(400);
      }
    });

    it("requires auth", async () => {
      const res = await fetch(`${server.baseUrl}/upload/encrypted/presign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size: 1024 }),
      });
      expect(res.status).toBe(401);
    });
  });
});
