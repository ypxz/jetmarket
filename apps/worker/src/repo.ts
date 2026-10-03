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
  users,
} from "@jetmarket/db/schema";
import type { OperatorCandidate } from "@jetmarket/domain";
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
  /** operatorId -> owner email, for quote-expiry notifications. */
  loadOperatorEmails(
    operatorIds: string[],
  ): Promise<{ operatorId: string; email: string }[]>;
  loadMatchContext(matchId: string): Promise<{
    matchId: string;
    rfqId: string;
    state: string;
    rfqStatus: string;
    operatorEmail: string;
    operatorName: string;
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
        .where(
          sql`not exists (select 1 from listings lf
                where lf.operator_id = ${operators.id}
                  and lf.vertical <> ${vertical})
           or exists (select 1 from listings ls
                where ls.operator_id = ${operators.id}
                  and ls.vertical = ${vertical})`,
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
      await db
        .update(rfqs)
        .set({ status: "matched" })
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
            ...(vertical
              ? [
                  sql`exists (
                    select 1 from rfqs r
                    where r.id = ${rfqMatches.rfqId}
                      and r.vertical = ${vertical}
                  )`,
                ]
              : []),
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
          operatorName: operators.name,
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

    async loadOperatorEmails(operatorIds) {
      if (!operatorIds.length) return [];
      return db
        .select({ operatorId: operators.id, email: users.email })
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
  };
}
