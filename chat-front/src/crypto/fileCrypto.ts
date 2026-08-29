/**
 * E2EE for DM attachments.
 *
 * Each file gets its own random AES-256-GCM key + IV. The ciphertext is
 * uploaded as an opaque blob (POST /upload/encrypted); the key, IV, and the
 * real metadata (name, MIME type, size) travel ONLY inside the message's
 * E2EE envelope — the server stores random bytes and a URL, and cannot learn
 * even the file type.
 *
 * WebCrypto (not noble) on purpose: files run to 10 MB and subtle.encrypt is
 * native-speed; per-file random keys make non-extractability moot. GCM's tag
 * authenticates the blob, so a swapped or corrupted download fails loudly.
 */
import { fromBase64, toBase64 } from "./primitives";

/**
 * WebCrypto args are always passed as Uint8Array VIEWS, never bare
 * ArrayBuffers: implementations accept cross-realm TypedArrays (checked via
 * ArrayBuffer.isView) but reject cross-realm ArrayBuffers (instanceof) —
 * which bites under jsdom/vitest where FileReader buffers come from another
 * realm. Views are equally valid BufferSource in every browser.
 */
type WebCryptoBytes = Uint8Array<ArrayBuffer>;

function asView(bytes: Uint8Array | ArrayBuffer): WebCryptoBytes {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view as WebCryptoBytes;
}

function b64ToView(b64: string): WebCryptoBytes {
  return asView(fromBase64(b64).slice());
}

/**
 * Blob.arrayBuffer() with a FileReader fallback (jsdom lacks the method).
 * The result is copied into a current-realm ArrayBuffer — a buffer produced
 * by jsdom's FileReader fails Node WebCrypto's cross-realm instanceof check.
 */
export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  const raw =
    typeof blob.arrayBuffer === "function"
      ? await blob.arrayBuffer()
      : await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(blob);
        });
  return new Uint8Array(raw).slice().buffer as ArrayBuffer;
}

export interface DmFileDescriptor {
  /** AES-256-GCM key, base64 (lives only inside the E2EE envelope). */
  k: string;
  /** 12-byte IV, base64. */
  iv: string;
  name: string;
  mime: string;
  /** plaintext size in bytes */
  size: number;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function encryptFileForDm(
  file: File
): Promise<{ blob: Blob; descriptor: DmFileDescriptor }> {
  if (file.size > MAX_FILE_BYTES) throw new Error("File exceeds the 10 MB limit");

  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    asView(await blobToArrayBuffer(file))
  );

  return {
    blob: new Blob([ciphertext], { type: "application/octet-stream" }),
    descriptor: {
      k: toBase64(key),
      iv: toBase64(iv),
      name: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size,
    },
  };
}

/** Decrypt a downloaded ciphertext back into a typed Blob. Throws on tamper. */
export async function decryptDmFile(
  descriptor: DmFileDescriptor,
  ciphertext: ArrayBuffer
): Promise<Blob> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    b64ToView(descriptor.k),
    "AES-GCM",
    false,
    ["decrypt"]
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToView(descriptor.iv) },
    cryptoKey,
    asView(ciphertext)
  );
  return new Blob([plaintext], { type: descriptor.mime });
}
