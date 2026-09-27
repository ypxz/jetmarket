import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

export default createMiddleware(routing);

export const config = {
  // Skip metadata-image routes too: opengraph-image-<hash> has no extension,
  // and locale-redirecting it breaks the emitted og:image URLs. `storage` is
  // excluded explicitly — extensionless keys have no dot to catch `.*\\..*`.
  matcher: ["/((?!api|_next|_vercel|storage|.*\\..*|.*-image.*).*)"],
};
