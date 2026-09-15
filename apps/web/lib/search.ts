import { getVertical } from "@jetmarket/verticals";
import type { FacetConfig } from "@jetmarket/verticals";
import { getRepo } from "./repo";
import type { Listing, ListingType } from "./repo/types";

/**
 * Config-driven public search: translates URL search params into a
 * Repo.listListings call. enum/text facets become exact filters (Postgres
 * jsonb-facet equivalents once @jetmarket/db lands); number-range facets
 * post-filter here until the db impl supports them natively — TODO(db).
 */

/** Facets with no attributeKey filter built-in Listing fields. */
const BUILTIN_FIELDS: Record<string, "type" | "price"> = {
  type: "type",
  price: "price",
};

function facetListingValue(l: Listing, f: FacetConfig): unknown {
  if (f.attributeKey) return l.attributes[f.attributeKey];
  const field = BUILTIN_FIELDS[f.key];
  return field ? l[field] : undefined;
}

function toNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export interface SearchParams {
  [key: string]: string | string[] | undefined;
}

export async function searchListings(params: SearchParams): Promise<Listing[]> {
  const vertical = getVertical();
  const exact: Record<string, string> = {};
  const ranges: { f: FacetConfig; min?: number; max?: number }[] = [];
  let type: ListingType | undefined;

  for (const facet of vertical.facets) {
    if (facet.type === "number-range") {
      const min = toNumber(str(params[`${facet.key}Min`]));
      const max = toNumber(str(params[`${facet.key}Max`]));
      if (min !== undefined || max !== undefined) ranges.push({ f: facet, min, max });
      continue;
    }
    const raw = str(params[facet.key]);
    if (!raw) continue;
    if (!facet.attributeKey) {
      // built-in facet (type) — maps to a typed repo filter
      if (facet.key === "type") type = raw as ListingType;
      continue;
    }
    // current text facets are codes (airport/country) — normalize to the
    // uppercase shape stored in attributes jsonb.
    exact[facet.attributeKey] = facet.type === "text" ? raw.toUpperCase() : raw;
  }

  const listings = await (await getRepo()).listListings({
    status: "active",
    vertical: vertical.slug,
    ...(str(params.q) ? { query: str(params.q)! } : {}),
    ...(type ? { type } : {}),
    ...(Object.keys(exact).length ? { facets: exact } : {}),
  });

  if (!ranges.length) return listings;
  return listings.filter((l) =>
    ranges.every(({ f, min, max }) => {
      const v = facetListingValue(l, f);
      if (v === undefined || v === null || v === "") return false;
      const n = Number(v);
      if (!Number.isFinite(n)) return false;
      if (min !== undefined && n < min) return false;
      if (max !== undefined && n > max) return false;
      return true;
    }),
  );
}

function str(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
