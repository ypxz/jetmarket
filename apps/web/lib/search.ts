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

interface ParsedParams {
  exact: Record<string, string>;
  ranges: { f: FacetConfig; min?: number; max?: number }[];
  type?: ListingType;
  query?: string;
}

function parseParams(params: SearchParams): ParsedParams {
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

  return {
    exact,
    ranges,
    ...(type ? { type } : {}),
    ...(str(params.q) ? { query: str(params.q)! } : {}),
  };
}

function repoFilter(p: ParsedParams) {
  return {
    status: "active" as const,
    vertical: getVertical().slug,
    ...(p.query ? { query: p.query } : {}),
    ...(p.type ? { type: p.type } : {}),
    ...(Object.keys(p.exact).length ? { facets: p.exact } : {}),
  };
}

function applyRanges(listings: Listing[], p: ParsedParams): Listing[] {
  if (!p.ranges.length) return listings;
  return listings.filter((l) =>
    p.ranges.every(({ f, min, max }) => {
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

/** Full filtered set — used by SEO landing pages that render everything. */
export async function searchListings(params: SearchParams): Promise<Listing[]> {
  const p = parseParams(params);
  const listings = await (await getRepo()).listListings(repoFilter(p));
  return applyRanges(listings, p);
}

export const SEARCH_PAGE_SIZE = 24;

export interface Page<T> {
  items: T[];
  /** 1-based, clamped into [1, pages]. */
  page: number;
  pages: number;
  total: number;
}

export function paginate<T>(items: T[], rawPage: unknown): Page<T> {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  const n = Number(rawPage);
  const page = Number.isInteger(n) && n >= 1 ? Math.min(n, pages) : 1;
  return {
    items: items.slice((page - 1) * SEARCH_PAGE_SIZE, page * SEARCH_PAGE_SIZE),
    page,
    pages,
    total,
  };
}

/**
 * Search page one-shot: repo-level count + page slice when no number-range
 * facet is active (exact facets run in SQL). With a range active the page
 * still falls back to fetch-then-slice — ranges stay app-side TODO(db).
 */
export async function searchListingsPage(
  params: SearchParams,
): Promise<Page<Listing>> {
  const p = parseParams(params);
  const repo = await getRepo();
  const n = Number(Array.isArray(params.page) ? params.page[0] : params.page);

  if (p.ranges.length) {
    return paginate(applyRanges(await repo.listListings(repoFilter(p)), p), params.page);
  }

  const total = await repo.countListings(repoFilter(p));
  const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  const page = Number.isInteger(n) && n >= 1 ? Math.min(n, pages) : 1;
  const items = await repo.listListings({
    ...repoFilter(p),
    limit: SEARCH_PAGE_SIZE,
    offset: (page - 1) * SEARCH_PAGE_SIZE,
  });
  return { items, page, pages, total };
}

function str(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
