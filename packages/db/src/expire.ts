import { sql } from "drizzle-orm";
import type { Db } from "./client";

export interface ExpireResult {
  /** RFQs flipped to 'closed' (iface "expired" has no db state). */
  rfqs: number;
  /** Their still-open ('sent') quotes flipped to 'declined'. */
  quotes: number;
}

/**
 * RFQ expiry sweep — one CTE pass. An RFQ is stale when status is open-ish
 * (new/matched/quoted) and its `fields.dateTo` is a YYYY-MM-DD strictly before
 * `cutoff` (day granularity: an RFQ is live through its last day). The RFQs go
 * to 'closed' (the web Repo iface maps "expired" there) and every still-'sent'
 * quote on them to 'declined' — a buyer can no longer act on a dead request.
 * Shared by the worker tick and DrizzleRepo.expireRfqs so both see identical
 * semantics.
 */
export async function expireStaleRfqs(db: Db, cutoff: Date): Promise<ExpireResult> {
  const rows = await db.execute(sql`
    WITH expired_rfqs AS (
      UPDATE rfqs SET status = 'closed'
      WHERE status IN ('new', 'matched', 'quoted')
        AND fields->>'dateTo' ~ '^\\d{4}-\\d{2}-\\d{2}$'
        AND (fields->>'dateTo')::date < ${cutoff.toISOString()}::date
      RETURNING id
    ),
    declined_quotes AS (
      UPDATE quotes SET status = 'declined', updated_at = now()
      WHERE status = 'sent'
        AND rfq_id IN (SELECT id FROM expired_rfqs)
      RETURNING id
    )
    SELECT
      (SELECT count(*)::int FROM expired_rfqs) AS rfqs,
      (SELECT count(*)::int FROM declined_quotes) AS quotes
  `);
  const row = (rows as unknown as ExpireResult[])[0];
  return { rfqs: row?.rfqs ?? 0, quotes: row?.quotes ?? 0 };
}
