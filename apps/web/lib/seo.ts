import { getVertical, type SeoPageDef, type VerticalConfig } from "@jetmarket/verticals";
import { defaultLocale, localePath, locales } from "@jetmarket/i18n";
import type { Metadata } from "next";
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

/**
 * Absolute URL for a path under one locale (QA-497). Paths are app-relative
 * ("/listing/x"); the default locale stays unprefixed like the router.
 */
export function localeUrl(locale: string, path: string): string {
  return `${siteUrl()}${localePath(locale, path)}`;
}

/**
 * hreflang language map for an indexable page — every locale's absolute URL
 * plus x-default pointing at the default locale. Used by both page metadata
 * and the sitemap so the two can never drift apart.
 */
export function languageUrls(path: string): Record<string, string> {
  return Object.fromEntries([
    ...locales.map((l) => [l, localeUrl(l, path)]),
    ["x-default", localeUrl(defaultLocale, path)],
  ]);
}

/**
 * Canonical + hreflang alternates for an indexable page (QA-497). The
 * canonical is SELF-referential in the page's own locale — a /de page must
 * not canonical to /en (that would tell search engines the German page is a
 * duplicate instead of a translation).
 */
export function seoAlternates(
  locale: string,
  path: string,
): Metadata["alternates"] {
  return {
    canonical: localeUrl(locale, path),
    languages: languageUrls(path),
  };
}
