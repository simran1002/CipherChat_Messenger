import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadEncryptedBlob } from "./encryptedUpload";
import api from "./api";

vi.mock("./api", () => ({
  default: { post: vi.fn() },
}));

const mockedPost = vi.mocked(api.post);

const blob = new Blob([new Uint8Array(64)], { type: "application/octet-stream" });

describe("uploadEncryptedBlob", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockedPost.mockReset();
  });

  it("PUTs directly to the bucket when the server presigns", async () => {
    mockedPost.mockResolvedValueOnce({
      data: {
        uploadUrl: "https://bucket.example/uploads/1-2.bin?sig=x",
        headers: { "Content-Type": "application/octet-stream" },
        url: "https://cdn.example.com/uploads/1-2.bin",
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const url = await uploadEncryptedBlob(blob);

    expect(url).toBe("https://cdn.example.com/uploads/1-2.bin");
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith("/upload/encrypted/presign", { size: blob.size });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bucket.example/uploads/1-2.bin?sig=x",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: blob,
      })
    );
  });

  it("falls back to the proxied upload when presign is unsupported (local driver)", async () => {
    mockedPost
      .mockRejectedValueOnce(Object.assign(new Error("501"), { response: { status: 501 } }))
      .mockResolvedValueOnce({ data: { url: "/uploads/3-4.bin" } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const url = await uploadEncryptedBlob(blob);

    expect(url).toBe("/uploads/3-4.bin");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedPost).toHaveBeenCalledTimes(2);
    const [path, body] = mockedPost.mock.calls[1];
    expect(path).toBe("/upload/encrypted");
    expect(body).toBeInstanceOf(FormData);
  });

  it("falls back when the bucket PUT itself fails (e.g. CORS, expired URL)", async () => {
    mockedPost
      .mockResolvedValueOnce({
        data: { uploadUrl: "https://bucket.example/x", headers: {}, url: "https://cdn/x" },
      })
      .mockResolvedValueOnce({ data: { url: "/uploads/5-6.bin" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 403 }));

    const url = await uploadEncryptedBlob(blob);

    expect(url).toBe("/uploads/5-6.bin");
    expect(mockedPost).toHaveBeenLastCalledWith("/upload/encrypted", expect.any(FormData));
  });

  it("surfaces the error when both paths fail", async () => {
    mockedPost.mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", vi.fn());

    await expect(uploadEncryptedBlob(blob)).rejects.toThrow("network down");
  });
});
