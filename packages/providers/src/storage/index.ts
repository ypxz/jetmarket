import { envOf } from "../env";
import type { Env } from "../env";
import { MockStorageProvider } from "./mock";
import { S3StorageProvider } from "./real";
import type { StorageProvider } from "./types";

export * from "./types";
export { MockStorageProvider } from "./mock";
export { S3StorageProvider } from "./real";

export type StorageProviderName = "mock" | "s3";

export function storageProviderName(env?: Env): StorageProviderName {
  const e = envOf(env);
  return (e.STORAGE_PROVIDER ?? "mock").toLowerCase() === "s3" ? "s3" : "mock";
}

/** STORAGE_PROVIDER: mock (default → STORAGE_DIR ./storage) | s3 (skeleton). */
export function createStorageProvider(env?: Env): StorageProvider {
  const e = envOf(env);
  switch (storageProviderName(e)) {
    case "s3":
      return new S3StorageProvider({
        bucket: e.S3_BUCKET ?? "",
        region: e.S3_REGION ?? "us-east-1",
        publicBaseUrl: e.S3_PUBLIC_BASE_URL,
        accessKeyId: e.S3_ACCESS_KEY_ID,
        secretAccessKey: e.S3_SECRET_ACCESS_KEY,
        endpoint: e.S3_ENDPOINT,
      });
    case "mock":
    default:
      return new MockStorageProvider({ dir: e.STORAGE_DIR });
  }
}

// Singleton survives dev-server HMR via globalThis.
const g = globalThis as unknown as { __jmStorage?: StorageProvider };
export function storageProvider(env?: Env): StorageProvider {
  if (!g.__jmStorage) g.__jmStorage = createStorageProvider(env);
  return g.__jmStorage;
}
