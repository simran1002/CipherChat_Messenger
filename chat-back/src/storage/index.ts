/**
 * Composition root for file storage — selected once at boot by STORAGE_DRIVER.
 *   local (default): uploads/ on disk, served by the /uploads static route.
 *   s3:              S3-compatible bucket (AWS, MinIO, R2) behind a public
 *                    base URL / CDN — required for multi-replica deployments
 *                    without a shared volume.
 */
import path from "node:path";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { IFileStorage } from "./interfaces.js";
import { LocalDiskStorage } from "./LocalDiskStorage.js";
import { S3Storage, createS3Client } from "./S3Storage.js";

export const uploadDir = path.join(__dirname, "..", "..", "uploads");

function build(): IFileStorage {
  if (env.STORAGE_DRIVER === "s3") {
    if (!env.S3_BUCKET || !env.S3_PUBLIC_BASE_URL) {
      throw new Error("STORAGE_DRIVER=s3 requires S3_BUCKET and S3_PUBLIC_BASE_URL");
    }
    logger.info("File storage: S3", {
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT ?? "aws",
    });
    return new S3Storage(
      createS3Client({
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
      }),
      { bucket: env.S3_BUCKET, publicBaseUrl: env.S3_PUBLIC_BASE_URL }
    );
  }
  return new LocalDiskStorage(uploadDir);
}

export const fileStorage: IFileStorage = build();
export type { IFileStorage, StoredFile, IncomingFile } from "./interfaces.js";
