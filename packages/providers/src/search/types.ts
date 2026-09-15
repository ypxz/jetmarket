/** One listing as returned by search — mirrors listings columns loosely. */
export interface SearchHit {
  id: string;
  vertical: string;
  type: string;
  title: string;
  attributes: Record<string, unknown>;
  priceMinor: number | null;
  currency: string;
  status: string;
  operatorId: string;
  photos: string[];
}

export interface SearchQuery {
  vertical: string;
  /** Free text against title + attributes (ilike/tsvector). */
  text?: string;
  /** Listing type facet (charter | empty_leg | aircraft_sale | ...). */
  type?: string;
  /** attribute-path exact matches, e.g. { aircraftCategory: "light", from: "ZRH" }. */
  filters?: Record<string, string | number>;
  /** Number-range filters, e.g. { seats: {min:6}, priceMinor: {max:...} }. */
  ranges?: Record<string, { min?: number; max?: number }>;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Total matching rows ignoring limit/offset. */
  total: number;
  /** Value → count for enum-ish facets when requested. */
  facets?: Record<string, Record<string, number>>;
}

/**
 * Listing search. postgres = the real impl (wraps the db `sql` client);
 * mock = in-memory; meilisearch = optional skeleton (TODO(go-live)).
 */
export interface SearchProvider {
  search(query: SearchQuery): Promise<SearchResult>;
}
