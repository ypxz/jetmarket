import type { VerticalConfig, SeoPageDef } from "@jetmarket/verticals";
import type { Listing } from "./repo/types";

/** Resolve a landingPage def for a URL slug on the active vertical. */
export function resolveSeoPage(
  vertical: VerticalConfig,
  slug: string,
): SeoPageDef | undefined {
  return vertical.seo.landingPages.find((p) => p.slug === slug);
}

/**
 * Map a SeoPageDef's `filters` onto the repo's listListings filter:
 * `type` selects the listing-type column, every other key filters
 * on listing attributes (facets).
 */
export function seoListingsQuery(def: SeoPageDef): {
  type?: Listing["type"];
  facets: Record<string, string>;
} {
  const { type, ...rest } = def.filters;
  return { type, facets: rest };
}

/** All public slugs for sitemap generation. */
export function seoSlugs(vertical: VerticalConfig): string[] {
  return vertical.seo.landingPages.map((p) => p.slug);
}

/** Short attribute summary shown under a listing title on SEO pages. */
export function listingSummary(l: Listing): string {
  const a = l.attributes;
  const parts: string[] = [];
  if (typeof a.model === "string" && a.model) parts.push(a.model);
  if (typeof a.make === "string" && a.make) parts.push(a.make);
  const from = a.from as string | undefined;
  const to = a.to as string | undefined;
  if (from && to) parts.push(`${from} → ${to}`);
  else if (typeof a.baseAirport === "string" && a.baseAirport)
    parts.push(`based ${a.baseAirport}`);
  if (typeof a.seats === "number") parts.push(`${a.seats} seats`);
  if (typeof a.machineryCategory === "string" && a.machineryCategory)
    parts.push(a.machineryCategory.replace(/_/g, " "));
  if (typeof a.yearOfManufacture === "number")
    parts.push(String(a.yearOfManufacture));
  else if (typeof a.year === "number") parts.push(String(a.year));
  return parts.join(" · ");
}
