import type { MetadataRoute } from "next";
import { routing } from "@/i18n/routing";
import { siteUrl } from "@/lib/seo";

// Private surfaces — under every locale, including the default: localePrefix
// is "as-needed" today (en unprefixed → /en/* rows are inert) but flipping it
// to "always" would silently expose /en/app without them (QA-315).
const PRIVATE_PATHS = [
  "/api",
  "/app",
  "/admin",
  "/search",
  "/quotes",
  "/rfq",
  "/sign-in",
];
const disallow = [
  ...PRIVATE_PATHS,
  ...routing.locales.flatMap((l) =>
    PRIVATE_PATHS.filter((p) => p !== "/api").map((p) => `/${l}${p}`),
  ),
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
