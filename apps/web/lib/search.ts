import { getVertical } from "@jetmarket/verticals";
import type { FacetConfig } from "@jetmarket/verticals";
import { getRepo } from "./repo";
import type { Listing, ListingType } from "./repo/types";

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
  const facetRanges = p.ranges.map(({ f, min, max }) => ({
    key: f.attributeKey ?? f.key,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  }));
  return {
    status: "active" as const,
    vertical: getVertical().slug,
    ...(p.query ? { query: p.query } : {}),
    ...(p.type ? { type: p.type } : {}),
    ...(Object.keys(p.exact).length ? { facets: p.exact } : {}),
    ...(facetRanges.length ? { facetRanges } : {}),
  };
}

/** Full filtered set — used by SEO landing pages that render everything. */
export async function searchListings(params: SearchParams): Promise<Listing[]> {
  const p = parseParams(params);
  return (await getRepo()).listListings(repoFilter(p));
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
