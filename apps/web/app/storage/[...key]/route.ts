import { storageProvider } from "@jetmarket/providers";

const TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Serves objects stored via the storage provider under its public base url
 * (/storage/<key>). In mock mode the provider reads STORAGE_DIR on disk.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const { key } = await params;
  const joined = key.join("/");
  try {
    const data = await storageProvider().get(joined);
    if (!data) return new Response("not found", { status: 404 });
    const ext = joined.split(".").pop()?.toLowerCase() ?? "";
    const headers: Record<string, string> = {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": "public, max-age=3600, immutable",
      "x-content-type-options": "nosniff",
    };
    // SVG can carry scripts — serve it inert (sandboxed + attachment) so an
    // uploaded file can't execute same-origin script.
    if (ext === "svg") {
      headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'";
      headers["content-disposition"] = "attachment";
    }
    return new Response(new Uint8Array(data), { headers });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
