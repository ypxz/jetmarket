import { todoGoLive } from "../errors";
import type { SearchProvider, SearchResult } from "./types";

const DOCS = "https://www.meilisearch.com/docs/reference/api/search";

export interface MeilisearchOptions {
  url: string; // MEILISEARCH_URL
  apiKey?: string; // MEILISEARCH_KEY
  /** Index name for listings (default: listings). */
  index?: string;
}

/**
 * Meilisearch adapter. Typed skeleton — the default stays Postgres search;
 * this drops in when catalogue outgrows SQL ilike.
 * TODO(go-live): wire meilisearch SDK, sync listings via jobs, facet config.
 * Docs: https://www.meilisearch.com/docs/reference/api/search
 */
export class MeilisearchProvider implements SearchProvider {
  constructor(readonly opts: MeilisearchOptions) {}

  search(): Promise<SearchResult> {
    // client.index(opts.index ?? "listings").search(query.text, { filter, facets })
    throw todoGoLive("meilisearch", "search", DOCS);
  }
}
