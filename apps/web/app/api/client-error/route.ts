import { z } from "zod";
import { clientIp, err, parseBody, rateLimit } from "@/lib/api";
import { logWarn } from "@/lib/log";

const Report = z.object({
  digest: z.string().max(64).optional(),
  message: z.string().max(500).optional(),
  path: z.string().max(300).optional(),
});

/**
 * Client-side crash beacon: the error boundaries sendBeacon here so a React
 * crash is visible in server logs (no error vendor wired yet — QA-335).
 * Unauthenticated, heavily rate-limited, log-only, never echoes user data
 * back — the response is intentionally empty.
 */
export async function POST(req: Request) {
  if (!rateLimit(`client-error:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, Report);
  if (error) return error;
  logWarn("client_error", {
    digest: data!.digest,
    message: data!.message,
    path: data!.path,
  });
  return new Response(null, { status: 204 });
}
