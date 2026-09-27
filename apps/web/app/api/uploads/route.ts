import { randomUUID } from "node:crypto";
import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { storageProvider } from "@jetmarket/providers";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/svg+xml",
  "image/gif",
]);
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/gif": "gif",
};

/** Operator photo upload → storage provider. Returns `{key, url}` for Listing.photos. */
export async function POST(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("sign in as an operator first", 401);
  if (!rateLimit(`upload:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }

  let file: File;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) return err("missing file", 422);
    file = f;
  } catch {
    return err("expected multipart/form-data with a file field", 422);
  }

  const type = file.type || "application/octet-stream";
  if (!ALLOWED.has(type)) return err("unsupported image type", 415);
  if (file.size === 0 || file.size > MAX_BYTES)
    return err("image must be between 1 byte and 5 MB", 422);

  const key = `uploads/${user.id}/${randomUUID().slice(0, 8)}.${EXT[type]}`;
  const stored = await storageProvider().put(
    key,
    new Uint8Array(await file.arrayBuffer()),
    { contentType: type },
  );
  return ok({ key: stored.key, url: stored.url }, 201);
}
