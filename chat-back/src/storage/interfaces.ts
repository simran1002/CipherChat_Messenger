/**
 * File storage contract. Same pattern as the reliability layer: one
 * interface, an implementation that needs nothing (local disk — dev, tests,
 * single-node), and one that scales (S3-compatible object storage — any
 * number of replicas, CDN-fronted, no shared volume).
 */

export interface IncomingFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface StoredFile {
  /** Public URL clients use to fetch the file (absolute for S3, path for local). */
  url: string;
  /** Storage-internal key (filename on disk / object key in the bucket). */
  key: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

export interface IFileStorage {
  readonly driver: "local" | "s3";
  put(file: IncomingFile): Promise<StoredFile>;
  /** Best-effort delete; never throws for a missing object. */
  delete(key: string): Promise<void>;
  /** Map a URL this storage produced back to its key (null if foreign). */
  keyFromUrl(url: string): string | null;
}

/** Filesystem-safe, collision-resistant object name that keeps the extension. */
export function makeObjectName(originalname: string): string {
  const ext = (originalname.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "").toLowerCase();
  const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  return `${unique}${ext}`;
}
