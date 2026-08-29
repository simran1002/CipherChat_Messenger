import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  makeObjectName,
  type IFileStorage,
  type IncomingFile,
  type PresignedUpload,
  type StoredFile,
} from "./interfaces.js";

/**
 * S3-compatible object storage (AWS S3, MinIO, Cloudflare R2, …).
 *
 * Objects are written under `uploads/` and served from `publicBaseUrl`
 * (a public bucket website endpoint or, better, a CDN in front of it). Public
 * base URL rather than presigned GET URLs: message documents store the URL
 * forever, and presigned URLs expire.
 *
 * The client is injected so tests can pass a fake `send()` — no network, no
 * extra mocking dependency.
 */
export interface S3StorageOptions {
  bucket: string;
  publicBaseUrl: string; // e.g. https://cdn.example.com  or  http://localhost:9000/cipherchat
  prefix?: string; // object key prefix, default "uploads"
}

type S3Like = Pick<S3Client, "send">;

/** Injectable so tests can fake the signature without AWS credentials. */
type SignUrlFn = (
  client: S3Like,
  command: PutObjectCommand,
  opts: { expiresIn: number }
) => Promise<string>;

const defaultSignUrl: SignUrlFn = (client, command, opts) =>
  getSignedUrl(client as S3Client, command, opts);

const PRESIGN_EXPIRES_SECONDS = 300;

export class S3Storage implements IFileStorage {
  readonly driver = "s3" as const;
  private readonly prefix: string;
  private readonly base: string;

  constructor(
    private readonly client: S3Like,
    private readonly opts: S3StorageOptions,
    private readonly signUrl: SignUrlFn = defaultSignUrl
  ) {
    this.prefix = (opts.prefix ?? "uploads").replace(/^\/+|\/+$/g, "");
    this.base = opts.publicBaseUrl.replace(/\/+$/, "");
  }

  async put(file: IncomingFile): Promise<StoredFile> {
    const key = `${this.prefix}/${makeObjectName(file.originalname)}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ContentLength: file.size,
        CacheControl: "public, max-age=31536000, immutable", // keys are unique
      })
    );
    return {
      url: `${this.base}/${key}`,
      key,
      fileName: file.originalname,
      mimeType: file.mimetype,
      fileSize: file.size,
    };
  }

  async delete(key: string): Promise<void> {
    if (!key.startsWith(`${this.prefix}/`)) return; // only our namespace
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }))
      .catch(() => {});
  }

  /**
   * Direct-to-bucket upload: the server signs, the browser PUTs. ContentType
   * and ContentLength are part of the signature — the bucket rejects a PUT
   * whose type or size differs from what the app authorized, so the size cap
   * enforced at the presign route can't be bypassed on the way to storage.
   */
  async presignPut(opts: { contentType: string; contentLength: number }): Promise<PresignedUpload> {
    const key = `${this.prefix}/${makeObjectName("blob.bin")}`;
    const command = new PutObjectCommand({
      Bucket: this.opts.bucket,
      Key: key,
      ContentType: opts.contentType,
      ContentLength: opts.contentLength,
      CacheControl: "public, max-age=31536000, immutable",
    });
    const uploadUrl = await this.signUrl(this.client, command, {
      expiresIn: PRESIGN_EXPIRES_SECONDS,
    });
    return {
      uploadUrl,
      headers: { "Content-Type": opts.contentType },
      url: `${this.base}/${key}`,
      key,
      expiresSeconds: PRESIGN_EXPIRES_SECONDS,
    };
  }

  keyFromUrl(url: string): string | null {
    if (!url.startsWith(`${this.base}/`)) return null;
    const key = url.slice(this.base.length + 1).split(/[?#]/)[0] ?? "";
    return key.startsWith(`${this.prefix}/`) ? key : null;
  }
}

/** Build a real S3Client from env-style options (endpoint = MinIO/R2 support). */
export function createS3Client(opts: {
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}): S3Client {
  return new S3Client({
    region: opts.region,
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    forcePathStyle: opts.forcePathStyle ?? Boolean(opts.endpoint),
    // credentials: default provider chain (env vars, shared config, IAM role)
  });
}
