import { getVertical, type SeoPageDef, type VerticalConfig } from "@jetmarket/verticals";
import { site } from "@jetmarket/config";

/** Resolve a landingPage def for a URL slug on the active vertical. */
export function resolveSeoPage(
  vertical: VerticalConfig,
  slug: string,
): SeoPageDef | undefined {
  return vertical.seo.landingPages.find((p) => p.slug === slug);
}

/** All public SEO slugs on the active vertical (sitemap + static params). */
export function seoSlugs(vertical: VerticalConfig = getVertical()): string[] {
  return vertical.seo.landingPages.map((p) => p.slug);
}

/** Public origin for absolute URLs (sitemap/canonical). */
export function siteUrl(): string {
  return process.env.APP_URL ?? `https://${site.domain}`;
}

/** Query string carrying a page's filters over to /search. */
export function searchHref(def: SeoPageDef): string {
  return `/search?${new URLSearchParams(def.filters).toString()}`;
}
