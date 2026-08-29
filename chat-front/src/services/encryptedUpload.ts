import api from "./api";

interface PresignResponse {
  uploadUrl: string;
  headers: Record<string, string>;
  url: string;
}

/**
 * Upload an already-encrypted attachment blob and return its durable URL.
 *
 * Fast path: ask the server to presign a direct-to-bucket PUT, then send the
 * ciphertext straight to object storage — the app server signs a URL but the
 * bytes never transit it. The PUT uses bare fetch on purpose: the axios
 * instance attaches an Authorization header, which is not part of the
 * presigned signature and must not reach the bucket.
 *
 * Fallback: any failure on the presign path (501 from the local-disk driver,
 * bucket CORS, network) drops to the proxied POST /upload/encrypted — same
 * bytes, same result, one extra hop.
 */
export async function uploadEncryptedBlob(blob: Blob): Promise<string> {
  try {
    const { data } = await api.post<PresignResponse>("/upload/encrypted/presign", {
      size: blob.size,
    });
    const put = await fetch(data.uploadUrl, {
      method: "PUT",
      headers: data.headers,
      body: blob,
    });
    if (!put.ok) throw new Error(`bucket PUT failed: ${put.status}`);
    return data.url;
  } catch {
    const fd = new FormData();
    fd.append("file", blob, "blob.bin"); // blob type is application/octet-stream
    const res = await api.post<{ url: string }>("/upload/encrypted", fd);
    return res.data.url;
  }
}
