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

/** Thin data access for worker handlers — keeps them unit-testable. */
export interface WorkerRepo {
  loadRfq(rfqId: string): Promise<{
    id: string;
    vertical: string;
    status: string;
    listingId: string | null;
    /** The RFQ's listing owner — fan-out must not match them with themselves. */
    ownerOperatorId: string | null;
    fields: Record<string, unknown>;
  } | null>;
  loadOperatorCandidates(vertical: string): Promise<OperatorCandidate[]>;
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
  /** Flip due delayed matches to pending; returns their ids. */
  deliverDueMatches(now: Date): Promise<string[]>;
  /** Delivered ('pending') matches whose notification job was never
   * enqueued — the flip→enqueue window isn't transactional, so a crash
   * between them strands the email forever (QA-162). Matches with a
   * terminal 'failed' job keep their row and are excluded on purpose:
   * they belong to admin retry, not an unbounded auto-resend loop. */
  unnotifiedPendingMatches(limit?: number): Promise<string[]>;
  /** RFQs still 'new' past the grace window with NO rfq.fanout job row at
   * all — the web route's enqueueJob can throw after the RFQ persisted
   * (QA-168), or a job row can be lost to admin cleanup. RFQs whose fanout
   * job exists in a terminal 'failed' state are excluded on purpose: they
   * belong to admin retry, not an unbounded auto-refanout loop. */
  unfanoutedRfqs(olderThan: Date, limit?: number): Promise<string[]>;
  /** Expiry sweep: stale open/quoted rfqs -> closed, their sent quotes ->
   * declined (shares the one-pass SQL with the web DrizzleRepo). Returns the
   * affected rows so the tick can notify buyers + operators. */
  expireRfqs(now: Date): Promise<ExpireResultDetailed>;
  /** operatorId -> owner email, for quote-expiry notifications. */
  loadOperatorEmails(
    operatorIds: string[],
  ): Promise<{ operatorId: string; email: string }[]>;
  loadMatchContext(matchId: string): Promise<{
    matchId: string;
    rfqId: string;
    state: string;
    operatorEmail: string;
    operatorName: string;
    rfqFields: Record<string, unknown>;
    buyerEmail: string;
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
          fields: rfqs.fields,
        })
        .from(rfqs)
        .leftJoin(listings, eq(rfqs.listingId, listings.id))
        .where(eq(rfqs.id, rfqId))
        .limit(1);
      return rows[0] ?? null;
    },

    async loadOperatorCandidates(vertical) {
      const ops = await db
        .select({
          id: operators.id,
          verified: operators.verified,
          plan: operators.plan,
          baseAirport: operators.baseAirport,
        })
        .from(operators);
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
            eq(listings.type, "charter"),
            eq(listings.status, "active"),
          ),
        );
      const fleet = new Map<string, OperatorCandidate["fleet"]>();
      for (const l of charter) {
        const a = l.attributes as Record<string, unknown>;
        const list = fleet.get(l.operatorId) ?? [];
        list.push({
          listingId: l.id,
          category: typeof a["aircraftCategory"] === "string" ? a["aircraftCategory"] : undefined,
          seats: typeof a["seats"] === "number" ? a["seats"] : undefined,
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

    async deliverDueMatches(now) {
      const rows = await db
        .update(rfqMatches)
        .set({ state: "pending" })
        .where(
          and(
            eq(rfqMatches.state, "delayed"),
            lte(rfqMatches.deliverAt, now),
          ),
        )
        .returning({ id: rfqMatches.id });
      return rows.map((r) => r.id);
    },

    async unnotifiedPendingMatches(limit = 200) {
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
          ),
        )
        .limit(limit);
      return rows.map((r) => r.id);
    },

    async unfanoutedRfqs(olderThan, limit = 100) {
      const rows = await db
        .select({ id: rfqs.id })
        .from(rfqs)
        .where(
          and(
            eq(rfqs.status, "new"),
            lt(rfqs.createdAt, olderThan),
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
          buyerEmail: rfqs.buyerEmail,
        })
        .from(rfqMatches)
        .innerJoin(operators, eq(rfqMatches.operatorId, operators.id))
        .innerJoin(users, eq(operators.userId, users.id))
        .innerJoin(rfqs, eq(rfqMatches.rfqId, rfqs.id))
        .where(eq(rfqMatches.id, matchId))
        .limit(1);
      return rows[0] ?? null;
    },

    async expireRfqs(now) {
      return expireStaleRfqsDetailed(db, now);
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
