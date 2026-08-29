import { describe, expect, it } from "vitest";
import { blobToArrayBuffer, decryptDmFile, encryptFileForDm } from "./fileCrypto";
import { parseDmContent, previewDmContent, serializeDmContent } from "./dmContent";

function makeFile(bytes: Uint8Array, name: string, type: string): File {
  return new File([bytes.slice().buffer as ArrayBuffer], name, { type });
}

describe("fileCrypto — E2EE DM attachments", () => {
  it("round-trips a file byte-for-byte with metadata intact", async () => {
    const payload = crypto.getRandomValues(new Uint8Array(4096));
    const { blob, descriptor } = await encryptFileForDm(makeFile(payload, "scan.pdf", "application/pdf"));

    expect(descriptor.name).toBe("scan.pdf");
    expect(descriptor.mime).toBe("application/pdf");
    expect(descriptor.size).toBe(4096);
    // ciphertext = plaintext + 16-byte GCM tag, and is NOT the plaintext
    expect(blob.size).toBe(4096 + 16);
    const cipherBytes = new Uint8Array(await blobToArrayBuffer(blob));
    expect(Array.from(cipherBytes.slice(0, 64))).not.toEqual(Array.from(payload.slice(0, 64)));

    const decrypted = await decryptDmFile(descriptor, await blobToArrayBuffer(blob));
    expect(decrypted.type).toBe("application/pdf");
    expect(new Uint8Array(await blobToArrayBuffer(decrypted))).toEqual(payload);
  });

  it("every encryption uses a fresh key and IV", async () => {
    const file = makeFile(new Uint8Array([1, 2, 3]), "a.bin", "application/octet-stream");
    const one = await encryptFileForDm(file);
    const two = await encryptFileForDm(file);
    expect(one.descriptor.k).not.toBe(two.descriptor.k);
    expect(one.descriptor.iv).not.toBe(two.descriptor.iv);
  });

  it("rejects tampered ciphertext and a wrong key", async () => {
    const { blob, descriptor } = await encryptFileForDm(
      makeFile(new Uint8Array(256), "x.png", "image/png")
    );
    const bytes = new Uint8Array(await blobToArrayBuffer(blob));
    bytes[10]! ^= 0x01;
    await expect(decryptDmFile(descriptor, bytes.buffer as ArrayBuffer)).rejects.toThrow();

    const { descriptor: other } = await encryptFileForDm(
      makeFile(new Uint8Array(16), "y.png", "image/png")
    );
    await expect(
      decryptDmFile({ ...descriptor, k: other.k }, await blobToArrayBuffer(blob))
    ).rejects.toThrow();
  });

  it("refuses files over the 10 MB cap without allocating ciphertext", async () => {
    const big = { size: 10 * 1024 * 1024 + 1, name: "big.iso", type: "", arrayBuffer: () => Promise.reject() } as unknown as File;
    await expect(encryptFileForDm(big)).rejects.toThrow(/10 MB/);
  });
});

describe("dmContent — envelope plaintext protocol", () => {
  it("plain text serializes as the raw string (envelope/history compat)", () => {
    expect(serializeDmContent({ t: "text", text: "hello" })).toBe("hello");
    expect(parseDmContent("hello")).toEqual({ t: "text", text: "hello" });
  });

  it("file content round-trips through JSON with the sentinel", () => {
    const file = { url: "/uploads/abc.bin", k: "a2V5", iv: "aXY=", name: "notes.txt", mime: "text/plain", size: 42 };
    const wire = serializeDmContent({ t: "file", file });
    expect(wire.startsWith('{"__dmc"')).toBe(true);
    expect(parseDmContent(wire)).toEqual({ t: "file", file });
  });

  it("hostile or malformed JSON falls back to text — never crashes rendering", () => {
    expect(parseDmContent('{"__dmc":1,"t":"file"}').t).toBe("text");
    expect(parseDmContent('{"__dmc":1,"t":"file","file":{"url":5}}').t).toBe("text");
    expect(parseDmContent('{"__dmc":oops').t).toBe("text");
    // a user legitimately typing JSON-ish text stays text
    expect(parseDmContent('{"hello":"world"}')).toEqual({ t: "text", text: '{"hello":"world"}' });
  });

  it("previews name files and pass through text", () => {
    expect(previewDmContent({ t: "text", text: "hi there" })).toBe("hi there");
    expect(
      previewDmContent({ t: "file", file: { url: "u", k: "k", iv: "i", name: "report.pdf", mime: "application/pdf", size: 1 } })
    ).toBe("📎 report.pdf");
  });
});
