import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import {
  expireStaleRfqsDetailed,
  type Db,
  type ExpireResultDetailed,
} from "@jetmarket/db";
import {
  listings,
  operators,
  rfqMatches,
  rfqs,
  searchAlerts,
  users,
} from "@jetmarket/db/schema";
import { fromMinorUnits, type OperatorCandidate } from "@jetmarket/domain";
import type { MatchingConfig } from "@jetmarket/verticals";

/** Thin data access for worker handlers — keeps them unit-testable. */
export interface WorkerRepo {
  loadRfq(rfqId: string): Promise<{
    id: string;
    vertical: string;
    status: string;
    listingId: string | null;
    /** The RFQ's listing owner — fan-out must not match them with themselves. */
    ownerOperatorId: string | null;
    /** The RFQ'd listing's attributes — fan-out infers the requirement's
     * category from them when the RFQ form doesn't ask for one (QA-229). */
    listingAttributes: Record<string, unknown> | null;
    fields: Record<string, unknown>;
    /** Buyer paid for concierge expedite — fan-out must deliver instantly,
     *  even for free/unverified matches (QA-399). */
    concierge: boolean;
  } | null>;
  loadOperatorCandidates(
    vertical: string,
    matching?: MatchingConfig,
  ): Promise<OperatorCandidate[]>;
  /** Insert matches; returns ids of actually-inserted rows w/ their state. */
  insertMatches(
    rows: {
      rfqId: string;
      operatorId: string;
      listingId: string | null;
      state: "pending" | "delayed";
      deliverAt: Date;
    }[],
  ): Promise<{ id: string; state: string }[]>;
  markRfqMatched(rfqId: string): Promise<void>;
  /** Flip due delayed matches to pending; returns their ids. `vertical`
   * scopes the sweep to this deploy's RFQs on shared DBs (QA-295). */
  deliverDueMatches(now: Date, vertical?: string): Promise<string[]>;
  /** Delivered ('pending') matches whose notification job was never
   * enqueued — the flip→enqueue window isn't transactional, so a crash
   * between them strands the email forever (QA-162). Matches with a
   * terminal 'failed' job keep their row and are excluded on purpose:
   * they belong to admin retry, not an unbounded auto-resend loop. */
  unnotifiedPendingMatches(limit?: number, vertical?: string): Promise<string[]>;
  /** RFQs still 'new' past the grace window with NO rfq.fanout job row at
   * all — the web route's enqueueJob can throw after the RFQ persisted
   * (QA-168), or a job row can be lost to admin cleanup. RFQs whose fanout
   * job exists in a terminal 'failed' state are excluded on purpose: they
   * belong to admin retry, not an unbounded auto-refanout loop. */
  unfanoutedRfqs(olderThan: Date, limit?: number, vertical?: string): Promise<string[]>;
  /** Expiry sweep: stale open/quoted rfqs -> closed, their sent quotes ->
   * declined (shares the one-pass SQL with the web DrizzleRepo). Returns the
   * affected rows so the tick can notify buyers + operators. */
  expireRfqs(now: Date, vertical?: string): Promise<ExpireResultDetailed>;
  /** Dated-inventory expiry sweep (QA-418): claims active listings whose
   * vertical expiry attr passed `now` and was never mailed on — the claim
   * stamps `expiry_mailed_at` inside the same UPDATE so concurrent ticks
   * can't double-mail. Returns the claimed rows for notification. */
  sweepExpiredListings(input: {
    vertical: string;
    type: string;
    attr: string;
    now: Date;
    limit?: number;
  }): Promise<
    {
      listingId: string;
      title: string;
      operatorName: string;
      operatorEmail: string;
      legDate: string;
      /** QA-494: recipient's sign-in locale for the expiry mail. */
      locale: string;
    }[]
  >;
  /** QA-422 stale-quote nudge: claim RFQs that sat 'quoted' with every live
   *  quote older than `olderThan` — one statement claims + stamps
   *  quote_nudge_mailed_at under the row lock so racing ticks mail once.
   *  A fresh quote resets the window (max(created_at) comparison). */
  sweepStaleQuotes(input: {
    vertical: string;
    olderThan: Date;
    limit?: number;
  }): Promise<
    {
      rfqId: string;
      buyerEmail: string;
      accessToken: string;
      listingTitle: string | null;
      quoteCount: number;
      /** QA-493: buyer-mail locale stamped at RFQ create. */
      locale: string;
    }[]
  >;
  /** QA-423 zero-quote nudge: claim RFQs that sat quote-less past
   *  `olderThan` — one statement claims + stamps no_quotes_mailed_at under
   *  the row lock so racing ticks mail once. 'quoted'/terminal rows and
   *  any RFQ with a live 'sent' quote are ineligible. */
  sweepUnquotedRfqs(input: {
    vertical: string;
    olderThan: Date;
    limit?: number;
  }): Promise<
    {
      rfqId: string;
      buyerEmail: string;
      accessToken: string;
      listingTitle: string | null;
      matchCount: number;
      /** QA-493: buyer-mail locale stamped at RFQ create. */
      locale: string;
    }[]
  >;
  /** QA-447 closing-soon nudge: claim live RFQs whose liveness horizon
   *  (the expire sweep's exact rule) lands within `dyingBefore` — one
   *  statement stamps closing_mailed_at under the row lock so racing
   *  ticks mail once. Rows already past the horizon (dead but unswept)
   *  are ineligible — the expired mail covers them. */
  sweepClosingSoonRfqs(input: {
    vertical: string;
    dyingBefore: Date;
    limit?: number;
  }): Promise<
    {
      rfqId: string;
      buyerEmail: string;
      accessToken: string;
      listingTitle: string | null;
      closesOn: string;
      quoteCount: number;
      /** QA-493: buyer-mail locale stamped at RFQ create. */
      locale: string;
    }[]
  >;
  /** QA-456 unrated-deal nudge: claim closed deals old enough to have been
   *  flown whose buyer never rated — one statement stamps
   *  rating_mailed_at under the row lock so racing ticks mail once.
   *  Once-ever per deal (no cooldown — a nudge that didn't convert stays
   *  quiet; the rate CAS is the terminal state). */
  sweepUnratedDeals(input: {
    vertical: string;
    olderThan: Date;
    limit?: number;
  }): Promise<
    {
      dealId: string;
      buyerEmail: string;
      accessToken: string;
      operatorName: string | null;
      listingTitle: string | null;
      /** QA-493: buyer-mail locale stamped on the deal's RFQ. */
      locale: string;
    }[]
  >;
  /** QA-516 unanswered-counter nudge: claim 'sent' quotes whose buyer
   *  counter sat unanswered past `olderThan` — one statement claims +
   *  stamps counter_nudge_mailed_at under the row lock so racing ticks
   *  mail once. Once-ever per counter round (reviseQuote clears the
   *  counter itself, letting a re-counter re-arm). Terminal quotes and
   *  dead RFQs are ineligible — the deal mails cover those. */
  sweepUnansweredCounters(input: {
    vertical: string;
    olderThan: Date;
    limit?: number;
  }): Promise<
    {
      quoteId: string;
      rfqId: string;
      operatorId: string;
      email: string;
      askAmount: number;
      counterAmount: number;
      currency: string;
      listingTitle: string | null;
      /** QA-494: recipient's sign-in locale for the nudge mail. */
      locale: string;
    }[]
  >;
  /** QA-425 unanswered-demand digest: claim operators who have at least
   *  one live, unquoted, undismissed RFQ older than `olderThan` in their
   *  inbox — one statement stamps unanswered_mailed_at under the row lock,
   *  and `cooldown` re-arms only after the stamp ages out (weekly-at-most
   *  mail, not once-ever). */
  sweepUnansweredOperators(input: {
    vertical: string;
    olderThan: Date;
    cooldown: Date;
    limit?: number;
  }): Promise<
    {
      operatorId: string;
      email: string;
      unansweredCount: number;
      /** QA-494: recipient's sign-in locale for the nudge mail. */
      locale: string;
    }[]
  >;
  /** QA-477 empty-book nudge: claim operators whose in-vertical book is
   *  still empty `olderThan` after signup — one statement stamps
   *  empty_book_mailed_at under the row lock. Once-ever (no cooldown): an
   *  operator either lists or doesn't; re-mailing an empty book forever is
   *  spam, and once they've listed the predicate goes false by itself.
   *  Suspended operators can't list — mailing them is pointless. */
  sweepEmptyBookOperators(input: {
    vertical: string;
    olderThan: Date;
    limit?: number;
  }): Promise<
    {
      operatorId: string;
      email: string;
      /** QA-494: recipient's sign-in locale for the nudge mail. */
      locale: string;
    }[]
  >;
  /** QA-429 overdue-invoice reminder: claim deals stuck 'invoiced' since
   *  before `olderThan` — one statement stamps invoice_reminded_at under
   *  the row lock, and `cooldown` re-arms only after the stamp ages out so
   *  a non-payer gets a weekly chase, not a drip and not never-again.
   *  Deals carry no vertical — resolved via quote → rfq (QA-313). */
  sweepOverdueInvoices(input: {
    vertical: string;
    olderThan: Date;
    cooldown: Date;
    limit?: number;
  }): Promise<
    {
      dealId: string;
      operatorId: string;
      email: string;
      invoiceRef: string | null;
      feeAmountMinor: number;
      currency: string;
      /** QA-494: recipient's sign-in locale for the reminder mail. */
      locale: string;
    }[]
  >;
  /** operatorId -> owner email, for quote-expiry notifications. */
  loadOperatorEmails(
    operatorIds: string[],
  ): Promise<
    {
      operatorId: string;
      email: string;
      /** QA-494: recipient's sign-in locale for the expiry mail. */
      locale: string;
    }[]
  >;
  loadMatchContext(matchId: string): Promise<{
    matchId: string;
    rfqId: string;
    state: string;
    rfqStatus: string;
    operatorEmail: string;
    /** QA-494: recipient's sign-in locale for the new-RFQ mail. */
    operatorLocale: string;
    operatorName: string;
    /** QA-505: false = the operator muted RFQ-match mail — the handler
     * marks the match sent and skips the email leg. */
    notifyRfqMatch: boolean;
    rfqFields: Record<string, unknown>;
    buyerEmail: string;
    /** Buyer paid for concierge expedite — the operator email flags it as
     * a priority request (QA-396). */
    rfqConcierge: boolean;
    /** Title of the RFQ'd listing — the notification subject under
     * non-route verticals (QA-234). */
    listingTitle: string | null;
  } | null>;
  markMatchState(matchId: string, state: "sent" | "failed"): Promise<void>;
  /** Saved-search alerts whose queued match backlog has matured past the
   * cooldown window — active rows only, scoped to this deploy's vertical
   * (QA-403). Params/token go back to the mail flush verbatim; matching
   * itself already ran web-side when the listing activated. */
  alertBacklogs(
    vertical: string,
    olderThan: Date,
    limit?: number,
  ): Promise<
    {
      id: string;
      email: string;
      params: Record<string, unknown>;
      token: string;
      pendingIds: string[];
      /** QA-496: digest mail renders + links in the alert's stamped locale. */
      locale: string;
    }[]
  >;
  /** Listing titles for digest mail — id+title only, active status kept so
   * the flush can drop delisted rows from the backlog. */
  loadDigestListings(
    ids: string[],
    vertical: string,
  ): Promise<{ id: string; title: string; status: string }[]>;
  /** Post-send: stamp last_alerted_at and flush pending_ids. */
  markSearchAlerted(id: string): Promise<void>;
}

export function createWorkerRepo(db: Db): WorkerRepo {
  return {
    async loadRfq(rfqId) {
      const rows = await db
        .select({
          id: rfqs.id,
          vertical: rfqs.vertical,
          status: rfqs.status,
          listingId: rfqs.listingId,
          ownerOperatorId: listings.operatorId,
          listingAttributes: listings.attributes,
          fields: rfqs.fields,
          concierge: rfqs.concierge,
        })
        .from(rfqs)
        .leftJoin(listings, eq(rfqs.listingId, listings.id))
        .where(eq(rfqs.id, rfqId))
        .limit(1);
      return rows[0] ?? null;
    },

    async loadOperatorCandidates(vertical, matching) {
      // Fleet shape is vertical-driven (QA-229): jets scan `charter` rows'
      // aircraftCategory/seats; machinery scans a dealer's whole stock for
      // machineryCategory, seat-agnostic.
      const catAttr = matching?.categoryAttribute ?? "aircraftCategory";
      const seatAttr = matching ? matching.seatsAttribute : "seats";
      // Shared-DB (QA-307): an operator whose entire book sits in a foreign
      // vertical is a dealer there, not a broker here — exclude them from
      // this deploy's fan-out. Zero-listing operators stay in: the
      // empty-fleet wildcard is for true brokers who source on demand.
      const ops = await db
        .select({
          id: operators.id,
          verified: operators.verified,
          plan: operators.plan,
          baseAirport: operators.baseAirport,
        })
        .from(operators)
        // The OR must stay parenthesized inside one fragment — a bare
        // `A or B` spliced into and() becomes `A or (B and C)` and every
        // zero-listing wildcard qualifies regardless of the AND clause.
        .where(
          sql`(not exists (select 1 from listings lf
                  where lf.operator_id = ${operators.id}
                    and lf.vertical <> ${vertical})
               or exists (select 1 from listings ls
                  where ls.operator_id = ${operators.id}
                    and ls.vertical = ${vertical}))
              and ${operators.acceptingRfqs}
              and not ${operators.suspended}`,
        );
      const charter = await db
        .select({
          operatorId: listings.operatorId,
          id: listings.id,
          attributes: listings.attributes,
        })
        .from(listings)
        .where(
          and(
            eq(listings.vertical, vertical),
            ...(matching?.fleetListingType
              ? [eq(listings.type, matching.fleetListingType)]
              : []),
            eq(listings.status, "active"),
          ),
        );
      const fleet = new Map<string, OperatorCandidate["fleet"]>();
      for (const l of charter) {
        const a = l.attributes as Record<string, unknown>;
        const list = fleet.get(l.operatorId) ?? [];
        list.push({
          listingId: l.id,
          category: typeof a[catAttr] === "string" ? a[catAttr] : undefined,
          seats:
            seatAttr !== undefined && typeof a[seatAttr] === "number"
              ? a[seatAttr]
              : undefined,
        });
        fleet.set(l.operatorId, list);
      }
      return ops.map((o) => ({
        id: o.id,
        verified: o.verified,
        planId: o.plan,
        baseAirport: o.baseAirport,
        fleet: fleet.get(o.id) ?? [],
      }));
    },

    async insertMatches(rows) {
      if (!rows.length) return [];
      const inserted = await db
        .insert(rfqMatches)
        .values(
          rows.map((r) => ({
            rfqId: r.rfqId,
            operatorId: r.operatorId,
            listingId: r.listingId,
            state: r.state,
            deliverAt: r.deliverAt,
          })),
        )
        .onConflictDoNothing({
          target: [rfqMatches.rfqId, rfqMatches.operatorId],
        })
        .returning({ id: rfqMatches.id, state: rfqMatches.state });
      return inserted;
    },

    async markRfqMatched(rfqId) {
      // Conditional: never resurrect a closed/spam RFQ back to matched.
      // updated_at bumps with every content write (QA-482) — the operator
      // inbox's "Updated" badge compares it to their last visit.
      await db
        .update(rfqs)
        .set({ status: "matched", updatedAt: new Date() })
        .where(and(eq(rfqs.id, rfqId), eq(rfqs.status, "new")));
    },

    async deliverDueMatches(now, vertical) {
      const rows = await db
        .update(rfqMatches)
        .set({ state: "pending" })
        .where(
          and(
            eq(rfqMatches.state, "delayed"),
            lte(rfqMatches.deliverAt, now),
            // Dead RFQs never deliver: a delayed match that comes due after
            // the parent closed/expired stays 'delayed' (and invisible)
            // instead of notifying operators about a dead request (QA-169).
            // The same EXISTS also pins the sweep to this deploy's vertical
            // on shared DBs (QA-295).
            sql`exists (
              select 1 from rfqs r
              where r.id = ${rfqMatches.rfqId}
                and r.status in ('new', 'matched', 'quoted')
                ${vertical ? sql`and r.vertical = ${vertical}` : sql``}
            )`,
          ),
        )
        .returning({ id: rfqMatches.id });
      return rows.map((r) => r.id);
    },

    async unnotifiedPendingMatches(limit = 200, vertical) {
      const rows = await db
        .select({ id: rfqMatches.id })
        .from(rfqMatches)
        .where(
          and(
            eq(rfqMatches.state, "pending"),
            sql`not exists (
              select 1 from jobs j
              where j.kind = 'email.quote_notification'
                and j.payload ->> 'matchId' = ${rfqMatches.id}::text
            )`,
            // Same dead-RFQ gate as deliverDueMatches (QA-169, QA-503): a
            // pending match on a closed RFQ is un-sendable — enqueueing it
            // only produces a warn-skip at the dead-gate. QA-499's orphan
            // sweep creates exactly this: pending matches whose RFQ closed
            // before a job ever landed.
            sql`exists (
              select 1 from rfqs r
              where r.id = ${rfqMatches.rfqId}
                and r.status in ('new', 'matched', 'quoted')
                ${vertical ? sql`and r.vertical = ${vertical}` : sql``}
            )`,
          ),
        )
        .limit(limit);
      return rows.map((r) => r.id);
    },

    async unfanoutedRfqs(olderThan, limit = 100, vertical) {
      const rows = await db
        .select({ id: rfqs.id })
        .from(rfqs)
        .where(
          and(
            eq(rfqs.status, "new"),
            lt(rfqs.createdAt, olderThan),
            ...(vertical ? [eq(rfqs.vertical, vertical)] : []),
            sql`not exists (
              select 1 from jobs j
              where j.kind = 'rfq.fanout'
                and j.payload ->> 'rfqId' = ${rfqs.id}::text
            )`,
          ),
        )
        .limit(limit);
      return rows.map((r) => r.id);
    },

    async loadMatchContext(matchId) {
      const rows = await db
        .select({
          matchId: rfqMatches.id,
          rfqId: rfqMatches.rfqId,
          state: rfqMatches.state,
          operatorEmail: users.email,
          operatorLocale: users.locale,
          operatorName: operators.name,
          notifyRfqMatch: operators.notifyRfqMatch,
          rfqFields: rfqs.fields,
          rfqStatus: rfqs.status,
          buyerEmail: rfqs.buyerEmail,
          rfqConcierge: rfqs.concierge,
          listingTitle: listings.title,
        })
        .from(rfqMatches)
        .innerJoin(operators, eq(rfqMatches.operatorId, operators.id))
        .innerJoin(users, eq(operators.userId, users.id))
        .innerJoin(rfqs, eq(rfqMatches.rfqId, rfqs.id))
        .leftJoin(listings, eq(rfqs.listingId, listings.id))
        .where(eq(rfqMatches.id, matchId))
        .limit(1);
      return rows[0] ?? null;
    },

    async expireRfqs(now, vertical) {
      return expireStaleRfqsDetailed(db, now, vertical);
    },

    async sweepExpiredListings({ vertical, type, attr, now, limit = 50 }) {
      // Same instant comparison as browseExpiry — a leg dated "today" is
      // already hidden from browse, so the mail fires at the same boundary.
      // The inner WHERE (expiry_mailed_at IS NULL) re-evaluates under the
      // row lock, so a racing tick stamps nothing twice.
      const rows = await db.execute<{
        listingId: string;
        title: string;
        operatorName: string;
        operatorEmail: string;
        legDate: string;
        locale: string;
      }>(sql`
        with due as (
          select l.id
          from listings l
          where l.vertical = ${vertical}
            and l.type = ${type}
            and l.status = 'active'
            and l.expiry_mailed_at is null
            and l.attributes ->> ${attr} is not null
            and (l.attributes ->> ${attr}) < ${now.toISOString()}
          limit ${limit}
        ),
        stamped as (
          update listings l
          set expiry_mailed_at = now()
          where l.id in (select id from due)
            and l.expiry_mailed_at is null
          returning
            l.id as "listingId",
            l.title,
            l.operator_id as "operatorId",
            l.attributes ->> ${attr} as "legDate"
        )
        select
          s."listingId",
          s.title,
          o.name as "operatorName",
          u.email as "operatorEmail",
          u.locale,
          s."legDate"
        from stamped s
        join operators o on o.id = s."operatorId"
        join users u on u.id = o.user_id
      `);
      return rows;
    },

    async sweepStaleQuotes({ vertical, olderThan, limit = 50 }) {
      // 'quoted' + every live (sent) quote stale = the RFQ went quiet after
      // quotes landed. The stamped CTE re-checks quote_nudge_mailed_at IS
      // NULL under the row lock — a racing tick mails nobody twice.
      const rows = await db.execute<{
        rfqId: string;
        buyerEmail: string;
        accessToken: string;
        locale: string;
        listingTitle: string | null;
        quoteCount: number;
      }>(sql`
        with due as (
          select r.id
          from rfqs r
          where r.vertical = ${vertical}
            and r.status = 'quoted'
            and r.quote_nudge_mailed_at is null
            and exists (
              select 1 from quotes q
              where q.rfq_id = r.id and q.status = 'sent'
            )
            and (
              select max(q2.created_at) from quotes q2
              where q2.rfq_id = r.id and q2.status = 'sent'
            ) < ${olderThan.toISOString()}
          limit ${limit}
        ),
        stamped as (
          update rfqs r
          set quote_nudge_mailed_at = now()
          where r.id in (select id from due)
            and r.quote_nudge_mailed_at is null
          returning
            r.id as "rfqId",
            r.buyer_email as "buyerEmail",
            r.access_token as "accessToken",
            r.listing_id as "listingId",
            r.locale
        )
        select
          s."rfqId",
          s."buyerEmail",
          s."accessToken",
          s.locale,
          l.title as "listingTitle",
          (
            select count(*)::int from quotes q
            where q.rfq_id = s."rfqId" and q.status = 'sent'
          ) as "quoteCount"
        from stamped s
        left join listings l on l.id = s."listingId"
      `);
      return rows;
    },

    async sweepUnquotedRfqs({ vertical, olderThan, limit = 50 }) {
      // 'new'/'matched' + zero live quotes past the window = the buyer heard
      // nothing since the confirmation mail — the lifecycle's last silence.
      // The stamped CTE re-checks no_quotes_mailed_at IS NULL under the row
      // lock — a racing tick mails nobody twice. A quote that lands between
      // claim and send is acceptable (same as QA-422): the buyer just got
      // better news than the nudge promised.
      const rows = await db.execute<{
        rfqId: string;
        buyerEmail: string;
        accessToken: string;
        locale: string;
        listingTitle: string | null;
        matchCount: number;
      }>(sql`
        with due as (
          select r.id
          from rfqs r
          where r.vertical = ${vertical}
            and r.status in ('new', 'matched')
            and r.no_quotes_mailed_at is null
            and r.created_at < ${olderThan.toISOString()}
            and not exists (
              select 1 from quotes q
              where q.rfq_id = r.id and q.status = 'sent'
            )
          limit ${limit}
        ),
        stamped as (
          update rfqs r
          set no_quotes_mailed_at = now()
          where r.id in (select id from due)
            and r.no_quotes_mailed_at is null
          returning
            r.id as "rfqId",
            r.buyer_email as "buyerEmail",
            r.access_token as "accessToken",
            r.listing_id as "listingId",
            r.locale
        )
        select
          s."rfqId",
          s."buyerEmail",
          s."accessToken",
          s.locale,
          l.title as "listingTitle",
          (
            select count(*)::int from rfq_matches m
            where m.rfq_id = s."rfqId" and m.state <> 'delayed'
          ) as "matchCount"
        from stamped s
        left join listings l on l.id = s."listingId"
      `);
      return rows;
    },

    async sweepClosingSoonRfqs({ vertical, dyingBefore, limit = 50 }) {
      // 'new'/'matched'/'quoted' + the QA-442 horizon inside the window =
      // the request dies soon and the buyer was never warned. The dated
      // arm is the expire predicate's own deadline form (dateTo+1d), the
      // undated arm the +30d horizon — both must be strictly ahead of now
      // (past-horizon rows belong to the expired mail). The stamped CTE
      // re-checks closing_mailed_at IS NULL under the row lock — a racing
      // tick mails nobody twice, and a QA-446 extend that lands between
      // claim and send is acceptable (the warning just came true early).
      const rows = await db.execute<{
        rfqId: string;
        buyerEmail: string;
        accessToken: string;
        locale: string;
        listingTitle: string | null;
        closesOn: string;
        quoteCount: number;
      }>(sql`
        with due as (
          select r.id
          from rfqs r
          where r.vertical = ${vertical}
            and r.status in ('new', 'matched', 'quoted')
            and r.closing_mailed_at is null
            and (
              (r.fields->>'dateTo' ~ '^\\d{4}-\\d{2}-\\d{2}$'
                and (r.fields->>'dateTo')::date + 1
                  between now()::date and ${dyingBefore.toISOString()}::date)
              or
              (coalesce(r.fields->>'dateTo', '') !~ '^\\d{4}-\\d{2}-\\d{2}$'
                and r.created_at + interval '30 days'
                  between now() and ${dyingBefore.toISOString()}::timestamptz)
            )
          limit ${limit}
        ),
        stamped as (
          update rfqs r
          set closing_mailed_at = now()
          where r.id in (select id from due)
            and r.closing_mailed_at is null
          returning
            r.id as "rfqId",
            r.buyer_email as "buyerEmail",
            r.access_token as "accessToken",
            r.listing_id as "listingId",
            r.fields->>'dateTo' as "dateTo",
            r.created_at as "createdAt",
            r.locale
        )
        select
          s."rfqId",
          s."buyerEmail",
          s."accessToken",
          s.locale,
          l.title as "listingTitle",
          (
            case
              when s."dateTo" ~ '^\\d{4}-\\d{2}-\\d{2}$'
                then (s."dateTo"::date + 1)::text
              else (s."createdAt" + interval '30 days')::date::text
            end
          ) as "closesOn",
          (
            select count(*)::int from quotes q
            where q.rfq_id = s."rfqId" and q.status = 'sent'
          ) as "quoteCount"
        from stamped s
        left join listings l on l.id = s."listingId"
      `);
      return rows;
    },

    async sweepUnratedDeals({ vertical, olderThan, limit = 50 }) {
      // Same two-phase shape as the other sweeps: `due` picks the claimable
      // rows, `stamped` re-checks rating_mailed_at IS NULL while updating so
      // racing ticks mail once. Vertical comes through the deal's rfq —
      // deals/quotes carry no vertical column (QA-313 rule).
      const rows = await db.execute<{
        dealId: string;
        buyerEmail: string;
        accessToken: string;
        locale: string;
        operatorName: string | null;
        listingTitle: string | null;
      }>(sql`
        with due as (
          select d.id
          from deals d
          join quotes q on q.id = d.quote_id
          join rfqs r on r.id = q.rfq_id
          where r.vertical = ${vertical}
            and d.buyer_rating is null
            and d.rating_mailed_at is null
            and d.closed_at < ${olderThan.toISOString()}::timestamptz
          limit ${limit}
        ),
        stamped as (
          update deals d
          set rating_mailed_at = now()
          where d.id in (select id from due)
            and d.rating_mailed_at is null
          returning d.id as "dealId", d.quote_id as "quoteId"
        )
        select
          s."dealId",
          r.buyer_email as "buyerEmail",
          r.access_token as "accessToken",
          r.locale,
          o.name as "operatorName",
          l.title as "listingTitle"
        from stamped s
        join quotes q on q.id = s."quoteId"
        join rfqs r on r.id = q.rfq_id
        left join operators o on o.id = q.operator_id
        left join listings l on l.id = r.listing_id
      `);
      return rows;
    },

    async sweepUnansweredCounters({ vertical, olderThan, limit = 50 }) {
      // The countered quote is the funnel's hottest lead — a buyer who
      // named a price and heard nothing is a deal dying of silence. `due`
      // picks countered-but-unanswered 'sent' quotes on live RFQs;
      // `stamped` re-checks counter_nudge_mailed_at IS NULL while updating
      // so racing ticks mail once. Once-ever per counter round — a revise
      // clears the counter entirely (and this stamp with it).
      const rows = await db.execute<{
        quoteId: string;
        rfqId: string;
        operatorId: string;
        email: string;
        askMinor: number;
        counterMinor: number;
        currency: string;
        listingTitle: string | null;
        locale: string;
      }>(sql`
        with due as (
          select q.id
          from quotes q
          join rfqs r on r.id = q.rfq_id
          where r.vertical = ${vertical}
            and q.status = 'sent'
            and q.countered_at is not null
            and q.countered_at < ${olderThan.toISOString()}::timestamptz
            and q.counter_nudge_mailed_at is null
            and r.status in ('new', 'matched', 'quoted')
          limit ${limit}
        ),
        stamped as (
          update quotes q
          set counter_nudge_mailed_at = now()
          where q.id in (select id from due)
            and q.counter_nudge_mailed_at is null
          returning q.id, q.rfq_id, q.operator_id,
                    q.amount_minor, q.counter_amount_minor, q.currency
        )
        select
          s.id as "quoteId",
          s.rfq_id as "rfqId",
          s.operator_id as "operatorId",
          u.email,
          s.amount_minor as "askMinor",
          s.counter_amount_minor as "counterMinor",
          s.currency,
          l.title as "listingTitle",
          u.locale
        from stamped s
        join rfqs r on r.id = s.rfq_id
        join operators o on o.id = s.operator_id
        join users u on u.id = o.user_id
        left join listings l on l.id = r.listing_id
      `);
      return rows.map((r) => ({
        quoteId: r.quoteId,
        rfqId: r.rfqId,
        operatorId: r.operatorId,
        email: r.email,
        askAmount: fromMinorUnits(r.askMinor, r.currency),
        counterAmount: fromMinorUnits(r.counterMinor, r.currency),
        currency: r.currency,
        listingTitle: r.listingTitle,
        locale: r.locale,
      }));
    },

    async sweepUnansweredOperators({
      vertical,
      olderThan,
      cooldown,
      limit = 50,
    }) {
      // Unanswered (QA-425) = live RFQ in this operator's inbox (owns the
      // listing OR holds a delivered match) AND the operator has no live
      // quote on it (the exact needsQuote predicate: declined/withdrawn
      // still count as unanswered) AND the operator didn't dismiss it — a
      // deliberate dismissal shouldn't drive a nudge. The stamp doubles as
      // the cooldown: re-arm only once it ages past `cooldown`.
      const unanswered = sql`
        exists (
          select 1
          from rfqs r
          left join listings l on l.id = r.listing_id
          where r.vertical = ${vertical}
            and r.status in ('new', 'matched')
            and r.created_at < ${olderThan.toISOString()}
            and (
              l.operator_id = o.id
              or exists (
                select 1 from rfq_matches m
                where m.rfq_id = r.id
                  and m.operator_id = o.id
                  and m.state <> 'delayed'
              )
            )
            and not exists (
              select 1 from quotes q
              where q.rfq_id = r.id
                and q.operator_id = o.id
                and q.status in ('sent', 'accepted')
            )
            and not exists (
              select 1 from rfq_dismissals d
              where d.rfq_id = r.id
                and d.operator_id = o.id
            )
        )`;
      const rows = await db.execute<{
        operatorId: string;
        email: string;
        unansweredCount: number;
        locale: string;
      }>(sql`
        with due as (
          select o.id
          from operators o
          where (
            o.unanswered_mailed_at is null
            or o.unanswered_mailed_at < ${cooldown.toISOString()}
          )
            and ${unanswered}
          limit ${limit}
        ),
        stamped as (
          update operators o
          set unanswered_mailed_at = now()
          where o.id in (select id from due)
            and (
              o.unanswered_mailed_at is null
              or o.unanswered_mailed_at < ${cooldown.toISOString()}
            )
          returning o.id, o.user_id
        )
        select
          s.id as "operatorId",
          u.email,
          u.locale,
          (
            select count(*)::int
            from rfqs r
            left join listings l on l.id = r.listing_id
            where r.vertical = ${vertical}
              and r.status in ('new', 'matched')
              and r.created_at < ${olderThan.toISOString()}
              and (
                l.operator_id = s.id
                or exists (
                  select 1 from rfq_matches m
                  where m.rfq_id = r.id
                    and m.operator_id = s.id
                    and m.state <> 'delayed'
                )
              )
              and not exists (
                select 1 from quotes q
                where q.rfq_id = r.id
                  and q.operator_id = s.id
                  and q.status in ('sent', 'accepted')
              )
              and not exists (
                select 1 from rfq_dismissals d
                where d.rfq_id = r.id
                  and d.operator_id = s.id
              )
          ) as "unansweredCount"
        from stamped s
        join users u on u.id = s.user_id
      `);
      return rows;
    },

    async sweepOverdueInvoices({ vertical, olderThan, cooldown, limit = 50 }) {
      // due → stamped (QA-418 pattern): the UPDATE re-checks the stamp under
      // the row lock so racing ticks can't double-mail the same deal. Deals
      // carry no vertical — scope via quote → rfq (QA-313).
      const rows = await db.execute<{
        dealId: string;
        operatorId: string;
        email: string;
        invoiceRef: string | null;
        feeAmountMinor: number;
        currency: string;
        locale: string;
      }>(sql`
        with due as (
          select d.id
          from deals d
          join quotes q on q.id = d.quote_id
          join rfqs r on r.id = q.rfq_id
          where d.invoice_status = 'invoiced'
            and d.closed_at < ${olderThan.toISOString()}
            and r.vertical = ${vertical}
            and (
              d.invoice_reminded_at is null
              or d.invoice_reminded_at < ${cooldown.toISOString()}
            )
          limit ${limit}
        ),
        stamped as (
          update deals d
          set invoice_reminded_at = now()
          where d.id in (select id from due)
            and (
              d.invoice_reminded_at is null
              or d.invoice_reminded_at < ${cooldown.toISOString()}
            )
          returning d.id
        )
        select
          s.id as "dealId",
          o.id as "operatorId",
          u.email,
          u.locale,
          d.invoice_ref as "invoiceRef",
          d.fee_amount_minor as "feeAmountMinor",
          d.currency
        from stamped s
        join deals d on d.id = s.id
        join quotes q on q.id = d.quote_id
        join operators o on o.id = q.operator_id
        join users u on u.id = o.user_id
      `);
      return rows;
    },

    async sweepEmptyBookOperators({ vertical, olderThan, limit = 50 }) {
      // due → stamped under the row lock (QA-418 pattern). The book check is
      // in-vertical on purpose: a dealer who only lists on machinery is
      // empty-book HERE — this deploy's nudge is about this vertical's
      // supply. Any listing row counts (draft/paused/archived): the nudge
      // is "create your first listing", not "publish" — a draft means they
      // already did the thing we nudge about.
      const rows = await db.execute<{
        operatorId: string;
        email: string;
        locale: string;
      }>(sql`
        with due as (
          select o.id
          from operators o
          where o.empty_book_mailed_at is null
            and o.created_at < ${olderThan.toISOString()}
            and not o.suspended
            and not exists (
              select 1
              from listings l
              where l.operator_id = o.id
                and l.vertical = ${vertical}
            )
          limit ${limit}
        ),
        stamped as (
          update operators o
          set empty_book_mailed_at = now()
          where o.id in (select id from due)
            and o.empty_book_mailed_at is null
          returning o.id, o.user_id
        )
        select s.id as "operatorId", u.email, u.locale
        from stamped s
        join users u on u.id = s.user_id
      `);
      return rows;
    },

    async loadOperatorEmails(operatorIds) {
      if (!operatorIds.length) return [];
      return db
        .select({
          operatorId: operators.id,
          email: users.email,
          locale: users.locale,
        })
        .from(operators)
        .innerJoin(users, eq(operators.userId, users.id))
        .where(inArray(operators.id, operatorIds));
    },

    async markMatchState(matchId, state) {
      await db
        .update(rfqMatches)
        .set({ state })
        .where(eq(rfqMatches.id, matchId));
    },

    async alertBacklogs(vertical, olderThan, limit = 100) {
      const rows = await db
        .select({
          id: searchAlerts.id,
          email: searchAlerts.email,
          params: searchAlerts.params,
          token: searchAlerts.token,
          pendingIds: searchAlerts.pendingIds,
          locale: searchAlerts.locale,
        })
        .from(searchAlerts)
        .where(
          and(
            eq(searchAlerts.vertical, vertical),
            eq(searchAlerts.status, "active"),
            sql`jsonb_array_length(${searchAlerts.pendingIds}) > 0`,
            // Maturity anchor: last mail, else subscription time. 'daily'
            // rows NEVER have last_alerted_at until their first flush —
            // without the coalesce they'd flush at the very next tick and
            // batch nothing (QA-406). Instant rows can't accumulate a
            // backlog without a prior mail, so coalesce ≢ their behavior.
            // Bound as a typed literal — postgres.js rejects JS Date values
            // inside raw sql fragments (QA-403 hit the same trap).
            sql`coalesce(${searchAlerts.lastAlertedAt}, ${searchAlerts.createdAt}) < ${olderThan.toISOString()}::timestamptz`,
          ),
        )
        .limit(limit);
      return rows;
    },

    async loadDigestListings(ids, vertical) {
      if (!ids.length) return [];
      return db
        .select({ id: listings.id, title: listings.title, status: listings.status })
        .from(listings)
        .where(
          and(
            inArray(listings.id, ids),
            eq(listings.vertical, vertical),
          ),
        );
    },

    async markSearchAlerted(id) {
      await db
        .update(searchAlerts)
        .set({ lastAlertedAt: new Date(), pendingIds: [] })
        .where(eq(searchAlerts.id, id));
    },
  };
}
