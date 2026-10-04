import { sql } from "drizzle-orm";
import type { Db } from "./client";

export interface ExpireResult {
  /** RFQs flipped to 'closed' (iface "expired" has no db state). */
  rfqs: number;
  /** Their still-open ('sent') quotes flipped to 'declined'. */
  quotes: number;
}

export interface ExpiredRfqInfo {
  id: string;
  buyerEmail: string;
  listingTitle: string | null;
  /** QA-493: buyer-mail locale, stamped at RFQ create. */
  locale: string;
}

export interface ExpiredQuoteInfo {
  id: string;
  rfqId: string;
  operatorId: string;
  amountMinor: number;
  currency: string;
  listingTitle: string | null;
}

export interface ExpireResultDetailed {
  rfqs: ExpiredRfqInfo[];
  quotes: ExpiredQuoteInfo[];
}

/**
 * RFQ expiry sweep — one CTE pass. An RFQ is stale when status is open-ish
 * (new/matched/quoted) and either: its `fields.dateTo` is a YYYY-MM-DD strictly
 * before `cutoff` (day granularity: an RFQ is live through its last day), or it
 * has no parseable dateTo (verticals where the field is optional, e.g. machinery
 * for-sale) and it was created more than 30 days before `cutoff`. The RFQs go
 * to 'closed' (the web Repo iface maps "expired" there) and every still-'sent'
 * quote on them to 'declined' — a buyer can no longer act on a dead request.
 * Shared by the worker tick and DrizzleRepo.expireRfqs so both see identical
 * semantics.
 */
export async function expireStaleRfqsDetailed(
  db: Db,
  cutoff: Date,
  /** Scope the sweep to one vertical on shared-DB deployments (QA-295). */
  vertical?: string,
): Promise<ExpireResultDetailed> {
  const vcond = vertical ? sql`AND vertical = ${vertical}` : sql``;
  const rows = await db.execute(sql`
    WITH expired_rfqs AS (
      UPDATE rfqs SET status = 'closed', updated_at = now()
      WHERE status IN ('new', 'matched', 'quoted')
        ${vcond}
        AND (
          -- dated request: live through dateTo, dead the day after
          (fields->>'dateTo' ~ '^\\d{4}-\\d{2}-\\d{2}$'
            AND (fields->>'dateTo')::date < ${cutoff.toISOString()}::date)
          OR
          -- undated/malformed request (e.g. machinery for-sale): 30-day stale horizon
          (coalesce(fields->>'dateTo', '') !~ '^\\d{4}-\\d{2}-\\d{2}$'
            AND created_at < ${cutoff.toISOString()}::timestamptz - interval '30 days')
        )
      RETURNING id, buyer_email, listing_id, locale
    ),
    declined_quotes AS (
      UPDATE quotes SET status = 'declined', updated_at = now()
      WHERE status = 'sent'
        AND rfq_id IN (SELECT id FROM expired_rfqs)
      RETURNING id, rfq_id, operator_id, amount_minor, currency
    )
    SELECT
      (SELECT coalesce(json_agg(row_to_json(t)), '[]') FROM (
        SELECT e.id, e.buyer_email AS "buyerEmail", e.locale,
               l.title AS "listingTitle"
        FROM expired_rfqs e LEFT JOIN listings l ON l.id = e.listing_id
      ) t) AS rfqs,
      (SELECT coalesce(json_agg(row_to_json(t)), '[]') FROM (
        SELECT q.id, q.rfq_id AS "rfqId", q.operator_id AS "operatorId",
               q.amount_minor AS "amountMinor", q.currency,
               l.title AS "listingTitle"
        FROM declined_quotes q
        JOIN expired_rfqs e ON e.id = q.rfq_id
        LEFT JOIN listings l ON l.id = e.listing_id
      ) t) AS quotes
  `);
  const row = (
    rows as unknown as { rfqs: ExpiredRfqInfo[]; quotes: ExpiredQuoteInfo[] }[]
  )[0];
  return { rfqs: row?.rfqs ?? [], quotes: row?.quotes ?? [] };
}

/** Count-only projection — the web Repo iface's shape. */
export async function expireStaleRfqs(
  db: Db,
  cutoff: Date,
  vertical?: string,
): Promise<ExpireResult> {
  const d = await expireStaleRfqsDetailed(db, cutoff, vertical);
  return { rfqs: d.rfqs.length, quotes: d.quotes.length };
}
