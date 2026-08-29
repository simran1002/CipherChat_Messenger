import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalDiskStorage } from "../../src/storage/LocalDiskStorage.js";
import { S3Storage } from "../../src/storage/S3Storage.js";
import { makeObjectName } from "../../src/storage/interfaces.js";

const sample = {
  buffer: Buffer.from("hello world"),
  originalname: "Report Final.PDF",
  mimetype: "application/pdf",
  size: 11,
};

describe("makeObjectName", () => {
  it("keeps a lowercase extension and is unique", () => {
    const a = makeObjectName("Photo.JPG");
    const b = makeObjectName("Photo.JPG");
    expect(a).toMatch(/^\d+-\d+\.jpg$/);
    expect(a).not.toBe(b);
  });
  it("drops suspicious or missing extensions", () => {
    expect(makeObjectName("noext")).toMatch(/^\d+-\d+$/);
    expect(makeObjectName("x.averyveryverylongext")).toMatch(/^\d+-\d+$/);
  });
});

describe("LocalDiskStorage", () => {
  let dir: string;
  let storage: LocalDiskStorage;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cipher-storage-"));
    storage = new LocalDiskStorage(dir, "/uploads");
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes the file and returns a /uploads URL", async () => {
    const stored = await storage.put(sample);
    expect(stored.url).toBe(`/uploads/${stored.key}`);
    expect(stored.key).toMatch(/\.pdf$/);
    expect(stored.fileName).toBe("Report Final.PDF");
    expect(stored.mimeType).toBe("application/pdf");
    expect(stored.fileSize).toBe(11);
    expect((await fs.readFile(path.join(dir, stored.key))).toString()).toBe("hello world");
  });

  it("maps its own URLs back to keys and rejects foreign ones", async () => {
    const stored = await storage.put(sample);
    expect(storage.keyFromUrl(stored.url)).toBe(stored.key);
    expect(storage.keyFromUrl(`http://localhost:8000${stored.url}?v=2`)).toBe(stored.key);
    expect(storage.keyFromUrl("https://cdn.example.com/uploads/x/y.png")).toBeNull();
    expect(storage.keyFromUrl("/other/thing.png")).toBeNull();
  });

  it("deletes by key, ignores missing files, and refuses path traversal", async () => {
    const stored = await storage.put(sample);
    await storage.delete(stored.key);
    await expect(fs.access(path.join(dir, stored.key))).rejects.toThrow();

    await expect(storage.delete("does-not-exist.png")).resolves.toBeUndefined();

    const outside = path.join(dir, "..", "cipher-storage-escape.txt");
    await fs.writeFile(outside, "keep me");
    await storage.delete("../cipher-storage-escape.txt");
    expect((await fs.readFile(outside)).toString()).toBe("keep me");
    await fs.rm(outside, { force: true });
  });
});

describe("S3Storage (fake client)", () => {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const fakeClient = {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      return {};
    }),
  };
  const storage = new S3Storage(fakeClient as never, {
    bucket: "cipherchat-media",
    publicBaseUrl: "https://cdn.example.com/",
  });

  it("PUTs under the uploads/ prefix with content-type and immutable caching", async () => {
    const stored = await storage.put(sample);
    const put = sent.find((s) => s.name === "PutObjectCommand")!;
    expect(put.input.Bucket).toBe("cipherchat-media");
    expect(put.input.Key).toMatch(/^uploads\/\d+-\d+\.pdf$/);
    expect(put.input.ContentType).toBe("application/pdf");
    expect(String(put.input.CacheControl)).toContain("immutable");
    expect(stored.url).toBe(`https://cdn.example.com/${stored.key}`);
  });

  it("maps its own URLs back to keys and refuses foreign/unprefixed ones", async () => {
    const stored = await storage.put(sample);
    expect(storage.keyFromUrl(stored.url)).toBe(stored.key);
    expect(storage.keyFromUrl("https://cdn.example.com/other/x.png")).toBeNull();
    expect(storage.keyFromUrl("https://evil.example.com/uploads/x.png")).toBeNull();
  });

  it("deletes only inside its namespace", async () => {
    sent.length = 0;
    await storage.delete("uploads/abc.png");
    expect(sent.some((s) => s.name === "DeleteObjectCommand" && s.input.Key === "uploads/abc.png")).toBe(true);
    sent.length = 0;
    await storage.delete("secrets/backup.json");
    expect(sent).toHaveLength(0);
  });

  describe("presignPut (direct-to-bucket uploads)", () => {
    it("signs a PUT that pins bucket, key, content type and length", async () => {
      const signed: Array<{ input: Record<string, unknown>; expiresIn: number }> = [];
      const withSigner = new S3Storage(
        fakeClient as never,
        { bucket: "cipherchat-media", publicBaseUrl: "https://cdn.example.com" },
        async (_client, command, opts) => {
          signed.push({ input: command.input as Record<string, unknown>, expiresIn: opts.expiresIn });
          return `https://cipherchat-media.s3.example/${command.input.Key}?X-Amz-Signature=fake`;
        }
      );

      const presigned = await withSigner.presignPut({
        contentType: "application/octet-stream",
        contentLength: 4096,
      });

      expect(signed).toHaveLength(1);
      expect(signed[0].input.Bucket).toBe("cipherchat-media");
      expect(signed[0].input.Key).toMatch(/^uploads\/\d+-\d+\.bin$/);
      expect(signed[0].input.ContentType).toBe("application/octet-stream");
      expect(signed[0].input.ContentLength).toBe(4096);
      expect(signed[0].expiresIn).toBeGreaterThan(0);

      expect(presigned.uploadUrl).toContain("X-Amz-Signature");
      expect(presigned.headers["Content-Type"]).toBe("application/octet-stream");
      // Durable URL points at the public base, not at the signed endpoint
      expect(presigned.url).toBe(`https://cdn.example.com/${presigned.key}`);
      expect(withSigner.keyFromUrl(presigned.url)).toBe(presigned.key);
    });
  });
});
