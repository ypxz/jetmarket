export interface StoredObject {
  key: string;
  /** Public-ish URL callers can embed in responses/markup. */
  url: string;
  bytes: number;
  contentType?: string;
}

/**
 * Object storage for listing photos. Keys are opaque slash-joined paths
 * (e.g. `seed/alpine-jet/l200-p0.svg`); providers must sanitize `..`.
 */
export interface StorageProvider {
  put(
    key: string,
    data: Uint8Array | string,
    opts?: { contentType?: string },
  ): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** URL embedding `key` — mock returns a local-serving path. */
  url(key: string): string;
}
