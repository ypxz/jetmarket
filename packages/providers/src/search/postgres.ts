import type { Sql } from "postgres";
import type { SearchProvider, SearchQuery, SearchResult } from "./types";

interface Row {
  id: string;
  vertical: string;
  type: string;
  title: string;
  attributes: Record<string, unknown>;
  price_minor: string | number | null;
  currency: string;
  status: string;
  operator_id: string;
  photos: string[];
  total: string | number;
}

const MAX_LIMIT = 100;

/**
 * Real search over the `listings` table: ilike free-text on title, jsonb
 * attribute equality for filters, numeric ranges (incl. top-level price),
 * facet counts for requested enum keys. Works against the compose postgres —
 * no extra service needed.
 */
export class PostgresSearchProvider implements SearchProvider {
  constructor(
    private readonly sql: Sql,
    /** Facet keys to compute counts for (subset of the query filters). */
    private readonly facetKeys: string[] = [],
  ) {}

  async search(query: SearchQuery): Promise<SearchResult> {
    const conditions = [
      this.sql`vertical = ${query.vertical}`,
      this.sql`status = 'active'`,
    ];
    if (query.type) conditions.push(this.sql`type = ${query.type}`);
    if (query.text?.trim()) {
      conditions.push(this.sql`title ilike ${"%" + query.text.trim() + "%"}`);
    }
    for (const [k, v] of Object.entries(query.filters ?? {})) {
      if (k === "priceMinor") {
        conditions.push(this.sql`price_minor = ${String(v)}`);
      } else if (typeof v === "number") {
        conditions.push(
          this.sql`(attributes ->> ${k})::numeric = ${v}`,
        );
      } else {
        conditions.push(this.sql`attributes ->> ${k} = ${v}`);
      }
    }
    for (const [k, r] of Object.entries(query.ranges ?? {})) {
      const col =
        k === "priceMinor"
          ? this.sql`price_minor`
          : this.sql`(attributes ->> ${k})::numeric`;
      if (r.min !== undefined) conditions.push(this.sql`${col} >= ${r.min}`);
      if (r.max !== undefined) conditions.push(this.sql`${col} <= ${r.max}`);
    }
    const where = conditions.reduce(
      (acc, c) => this.sql`${acc} and ${c}`,
      this.sql`true`,
    );
    const limit = Math.min(query.limit ?? 24, MAX_LIMIT);
    const offset = query.offset ?? 0;

    const rows = await this.sql<Row[]>`
      select id, vertical, type, title, attributes, price_minor, currency,
             status, operator_id, photos,
             count(*) over () as total
        from listings
       where ${where}
       order by created_at desc
       limit ${limit} offset ${offset}
    `;

    const result: SearchResult = {
      hits: rows.map((r) => ({
        id: r.id,
        vertical: r.vertical,
        type: r.type,
        title: r.title,
        attributes: r.attributes ?? {},
        priceMinor: r.price_minor === null ? null : Number(r.price_minor),
        currency: r.currency,
        status: r.status,
        operatorId: r.operator_id,
        photos: r.photos ?? [],
      })),
      total: rows.length ? Number(rows[0]!.total) : 0,
    };

    if (this.facetKeys.length) {
      result.facets = {};
      for (const key of this.facetKeys) {
        // `type` is a real column; other facets read attributes ->> key.
        const valueExpr =
          key === "type" ? this.sql`type` : this.sql`attributes ->> ${key}`;
        const facetRows = await this.sql<{ v: string; c: number }[]>`
          select ${valueExpr} as v, count(*)::int as c
            from listings
           where ${where}
           group by 1 order by 2 desc
        `;
        result.facets[key] = Object.fromEntries(
          facetRows.filter((f) => f.v !== null).map((f) => [f.v, f.c]),
        );
      }
    }
    return result;
  }
}
