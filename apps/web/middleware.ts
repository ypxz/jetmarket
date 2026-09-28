import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "./lib/api";
import { routing } from "./i18n/routing";

const intl = createMiddleware(routing);

// Page renders aren't covered by the per-route API limits — cap the whole
// HTML surface per IP so a scraper can't hammer search/detail renders.
// Generous: real browsing is a few pages/minute; shared-NAT bursts pass too.
export default function middleware(req: NextRequest) {
  if (!rateLimit(`page:${clientIp(req)}`, 1200, 60 * 60 * 1000)) {
    return new NextResponse("rate limit exceeded — try again later", {
      status: 429,
    });
  }
  return intl(req);
}

export const config = {
  // Skip metadata-image routes too: opengraph-image-<hash> has no extension,
  // and locale-redirecting it breaks the emitted og:image URLs. `storage` is
  // excluded explicitly — extensionless keys have no dot to catch `.*\\..*`.
  matcher: ["/((?!api|_next|_vercel|storage|.*\\..*|.*-image.*).*)"],
};
