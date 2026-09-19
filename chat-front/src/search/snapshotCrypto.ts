/**
 * Encryption of search snapshots at rest.
 *
 * A snapshot is the list of indexed docs for ONE conversation, sealed with AES-256-GCM under a
 * non-extractable WebCrypto key that lives in IndexedDB. The conversation id is bound as AAD so a
 * blob cannot be swapped under another conversation's row. One blob per conversation is what makes
 * shredding cheap: deleting a conversation's row removes its searchable plaintext completely.
 */
import type { SearchDoc } from "./searchCore";

export interface SealedSnapshot {
  v: 1;
  convId: string;
  iv: Uint8Array;
  blob: Uint8Array;
  count: number;
  savedAt: number;
}

export async function generateSnapshotKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function sealSnapshot(key: CryptoKey, convId: string, docs: SearchDoc[]): Promise<SealedSnapshot> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const blob = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(`search-snapshot:v1:${convId}`) },
      key,
      enc.encode(JSON.stringify(docs))
    )
  );
  return { v: 1, convId, iv, blob, count: docs.length, savedAt: Date.now() };
}

/** Throws if the blob was tampered with, truncated, or belongs to a different conversation. */
export async function openSnapshot(key: CryptoKey, snapshot: SealedSnapshot): Promise<SearchDoc[]> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: snapshot.iv as BufferSource, additionalData: enc.encode(`search-snapshot:v1:${snapshot.convId}`) },
    key,
    snapshot.blob as BufferSource
  );
  return JSON.parse(dec.decode(pt)) as SearchDoc[];
}
