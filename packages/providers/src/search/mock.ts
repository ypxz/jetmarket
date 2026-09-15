import type { SearchHit, SearchProvider, SearchQuery, SearchResult } from "./types";

/**
 * In-memory search for mock mode/tests. Callers feed it hits (e.g. seed
 * listings mapped through `toSearchHit`); matching mirrors the postgres impl:
 * ilike on title, exact attribute equality, numeric ranges.
 */
export class MockSearchProvider implements SearchProvider {
  private hits: SearchHit[] = [];

  /** Replace the searchable corpus. */
  seed(hits: SearchHit[]): void {
    this.hits = hits;
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const text = query.text?.trim().toLowerCase();
    const filtered = this.hits.filter((h) => {
      if (h.vertical !== query.vertical) return false;
      if (h.status !== "active") return false;
      if (query.type && h.type !== query.type) return false;
      if (text && !h.title.toLowerCase().includes(text)) return false;
      for (const [k, v] of Object.entries(query.filters ?? {})) {
        if (k === "priceMinor") {
          if (h.priceMinor !== v) return false;
        } else if (h.attributes[k] !== v) {
          return false;
        }
      }
      for (const [k, r] of Object.entries(query.ranges ?? {})) {
        const v =
          k === "priceMinor"
            ? h.priceMinor
            : typeof h.attributes[k] === "number"
              ? (h.attributes[k] as number)
              : null;
        if (v === null) return false;
        if (r.min !== undefined && v < r.min) return false;
        if (r.max !== undefined && v > r.max) return false;
      }
      return true;
    });
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 24;
    return {
      hits: filtered.slice(offset, offset + limit),
      total: filtered.length,
    };
  }
}
