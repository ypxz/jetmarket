import { getVertical } from "@jetmarket/verticals";
import type { FacetConfig } from "@jetmarket/verticals";
import { getRepo } from "./repo";
import type { Listing, ListingSort, ListingType } from "./repo/types";

/**
 * Config-driven public search: translates URL search params into a
 * Repo.listListings call. enum/text facets become exact filters and
 * number-range facets become facetRanges — both resolved inside the repo
 * impls (SQL for postgres) so pagination counts and slices agree.
 */

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
  dateRanges: { f: FacetConfig; from?: string; to?: string }[];
  type?: ListingType;
  query?: string;
  sort?: ListingSort;
  verifiedOnly?: boolean;
}

const SORTS: ListingSort[] = ["newest", "price_asc", "price_desc"];

function parseParams(params: SearchParams): ParsedParams {
  const vertical = getVertical();
  const exact: Record<string, string> = {};
  const ranges: { f: FacetConfig; min?: number; max?: number }[] = [];
  const dateRanges: { f: FacetConfig; from?: string; to?: string }[] = [];
  let type: ListingType | undefined;

  for (const facet of vertical.facets) {
    if (facet.type === "number-range") {
      const min = toNumber(str(params[`${facet.key}Min`]));
      const max = toNumber(str(params[`${facet.key}Max`]));
      if (min !== undefined || max !== undefined) ranges.push({ f: facet, min, max });
      continue;
    }
    if (facet.type === "date-range") {
      // `<key>From`/`<key>To` params; ISO-shaped strings only — anything else
      // simply doesn't filter (same fail-open posture as unknown sort values).
      const iso = (v: string | undefined) =>
        v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
      const from = iso(str(params[`${facet.key}From`]));
      const to = iso(str(params[`${facet.key}To`]));
      if (from || to) dateRanges.push({ f: facet, from, to });
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

  const q = str(params.q)?.slice(0, 200);
  const sortRaw = str(params.sort);
  return {
    exact,
    ranges,
    dateRanges,
    ...(type ? { type } : {}),
    ...(q ? { query: q } : {}),
    // Unknown sort values degrade to the newest-first default, not a 400.
    ...(SORTS.includes(sortRaw as ListingSort)
      ? { sort: sortRaw as ListingSort }
      : {}),
    // QA-436: `verified=1` keeps only verified operators' listings. Any other
    // value is ignored (fail-open, same posture as unknown sorts).
    ...(str(params.verified) === "1" ? { verifiedOnly: true } : {}),
  };
}

/**
 * Public listing filter from raw URL params — facets are whitelisted to the
 * active vertical's declared set (extra `f_*`/unknown keys are ignored), so
 * scrapers can't probe arbitrary jsonb paths. Used by the search pages and
 * GET /api/listings (QA-143).
 */
export function listingFilterFor(params: SearchParams) {
  return repoFilter(parseParams(params));
}

/**
 * Dated-inventory expiry fragment for public browse reads — spreads into a
 * `listListings`/`countListings` filter. Empty when the vertical declares no
 * `expiry` (machinery has none — QA-219).
 */
export function browseExpiry() {
  const expiry = getVertical().expiry;
  if (!expiry) return {};
  return {
    notExpiredByAttr: {
      type: expiry.type,
      attr: expiry.attributeKey,
      asOf: new Date().toISOString().slice(0, 10),
    },
  } as const;
}

/**
 * Per-listing form of `browseExpiry` — true when this row is the vertical's
 * dated one-shot inventory and its date is already past. Public detail/RFQ
 * surfaces treat expired as gone (QA-220).
 */
export function isExpiredListing(l: {
  type: string;
  attributes: Record<string, unknown>;
}): boolean {
  const expiry = getVertical().expiry;
  if (!expiry || l.type !== expiry.type) return false;
  const v = l.attributes[expiry.attributeKey];
  return typeof v === "string" && v < new Date().toISOString().slice(0, 10);
}

function repoFilter(p: ParsedParams) {
  const facetRanges = p.ranges.map(({ f, min, max }) => ({
    key: f.attributeKey ?? f.key,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  }));
  const facetDateRanges = p.dateRanges.map(({ f, from, to }) => ({
    key: f.attributeKey ?? f.key,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  }));
  return {
    status: "active" as const,
    vertical: getVertical().slug,
    ...(p.query ? { query: p.query } : {}),
    ...(p.type ? { type: p.type } : {}),
    ...(p.sort ? { sort: p.sort } : {}),
    ...(Object.keys(p.exact).length ? { facets: p.exact } : {}),
    ...(facetRanges.length ? { facetRanges } : {}),
    ...(facetDateRanges.length ? { facetDateRanges } : {}),
    ...(p.verifiedOnly ? { verifiedOnly: true } : {}),
    ...browseExpiry(),
  };
}

/**
 * Filtered listing set for SEO landing pages. Unfiltered reads are capped at
 * `limit` (default 48) — a landing page is a teaser for /search, which has
 * its own pager, so rendering every match is never the intent.
 */
export async function searchListings(
  params: SearchParams,
  limit = 48,
): Promise<Listing[]> {
  const p = parseParams(params);
  return (await getRepo()).listListings({ ...repoFilter(p), limit });
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
 * Search page one-shot: repo-level count + page slice. Exact facets and
 * number ranges both run in the repo filter, so count and slice always
 * describe the same set.
 */
export async function searchListingsPage(
  params: SearchParams,
): Promise<Page<Listing>> {
  const p = parseParams(params);
  const repo = await getRepo();
  const n = Number(Array.isArray(params.page) ? params.page[0] : params.page);

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
