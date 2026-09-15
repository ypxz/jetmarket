import { todoGoLive } from "../errors";
import type { StorageProvider, StoredObject } from "./types";

const DOCS = "https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/";

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Optional CDN/public base; defaults to virtual-hosted S3 URL. */
  publicBaseUrl?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Custom endpoint (MinIO, R2, LocalStack). */
  endpoint?: string;
}

/**
 * S3-compatible object storage. Typed skeleton — signatures final.
 * TODO(go-live): add @aws-sdk/client-s3 dep + wire PutObject/GetObject/
 * DeleteObject; presigned or CDN-fronted urls.
 * Docs: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/
 */
export class S3StorageProvider implements StorageProvider {
  constructor(readonly opts: S3StorageOptions) {}

  put(): Promise<StoredObject> {
    // new S3Client({ region, endpoint, credentials }).send(PutObjectCommand)
    throw todoGoLive("s3", "put", DOCS);
  }
  get(): Promise<Uint8Array | null> {
    throw todoGoLive("s3", "get", DOCS);
  }
  delete(): Promise<void> {
    throw todoGoLive("s3", "delete", DOCS);
  }
  url(key: string): string {
    const base =
      this.opts.publicBaseUrl ??
      `https://${this.opts.bucket}.s3.${this.opts.region}.amazonaws.com`;
    return `${base}/${key}`;
  }
}
