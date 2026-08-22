import fs from "node:fs/promises";
import path from "node:path";
import { makeObjectName, type IFileStorage, type IncomingFile, type StoredFile } from "./interfaces.js";

/**
 * Local-disk storage: files land in `uploads/` and are served by the
 * `/uploads` static route in app.ts. Fine for dev and single-node deploys;
 * multi-replica deploys need a shared volume — or the S3 driver.
 */
export class LocalDiskStorage implements IFileStorage {
  readonly driver = "local" as const;

  constructor(
    private readonly dir: string,
    private readonly publicPrefix = "/uploads"
  ) {}

  async put(file: IncomingFile): Promise<StoredFile> {
    await fs.mkdir(this.dir, { recursive: true });
    const key = makeObjectName(file.originalname);
    await fs.writeFile(path.join(this.dir, key), file.buffer);
    return {
      url: `${this.publicPrefix}/${key}`,
      key,
      fileName: file.originalname,
      mimeType: file.mimetype,
      fileSize: file.size,
    };
  }

  async delete(key: string): Promise<void> {
    // Refuse anything that isn't a bare filename — never walk out of the dir
    if (!key || key.includes("/") || key.includes("\\") || key.includes("..")) return;
    await fs.unlink(path.join(this.dir, key)).catch(() => {});
  }

  keyFromUrl(url: string): string | null {
    const idx = url.indexOf(`${this.publicPrefix}/`);
    if (idx === -1) return null;
    const key = url.slice(idx + this.publicPrefix.length + 1).split(/[?#]/)[0] ?? "";
    return key && !key.includes("/") ? key : null;
  }
}
