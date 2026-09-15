import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, normalize, resolve, sep } from "node:path";
import type { StorageProvider, StoredObject } from "./types";

export interface MockStorageOptions {
  /** Root dir (STORAGE_DIR; default ./storage). */
  dir?: string;
  /** Path prefix embedded in urls (default /storage — serve from dev server). */
  publicBaseUrl?: string;
}

/** Reject keys escaping the storage root. */
function safeJoin(root: string, key: string): string {
  const abs = resolve(root, normalize(key));
  if (abs !== resolve(root) && !abs.startsWith(resolve(root) + sep)) {
    throw new Error(`storage key escapes root: ${key}`);
  }
  return abs;
}

/** Local-filesystem storage under STORAGE_DIR — the mock/dev implementation. */
export class MockStorageProvider implements StorageProvider {
  private readonly dir: string;
  private readonly baseUrl: string;

  constructor(opts: MockStorageOptions = {}) {
    this.dir = opts.dir ?? "./storage";
    this.baseUrl = opts.publicBaseUrl ?? "/storage";
  }

  async put(
    key: string,
    data: Uint8Array | string,
    opts?: { contentType?: string },
  ): Promise<StoredObject> {
    const path = safeJoin(this.dir, key);
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(path, data);
    return {
      key,
      url: this.url(key),
      bytes: statSync(path).size,
      contentType: opts?.contentType,
    };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return readFileSync(safeJoin(this.dir, key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    rmSync(safeJoin(this.dir, key), { force: true });
  }

  url(key: string): string {
    return `${this.baseUrl}/${key.split(sep).join("/")}`;
  }
}
