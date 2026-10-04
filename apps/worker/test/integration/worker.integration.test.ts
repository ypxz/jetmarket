import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimJobs,
  createDb,
  databaseUrl,
  enqueueJob,
  ensureTestDatabase,
  pruneJobs,
  runMigrations,
  seedJets,
  testDatabaseUrlFrom,
} from "@jetmarket/db";
import {
  rfqMatches,
  rfqs,
  quotes,
  deals,
  searchAlerts,
  users,
  operators,
  listings,
} from "@jetmarket/db/schema";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockEmailProvider, readOutbox } from "@jetmarket/providers/email/index";
import { defaultPlans } from "@jetmarket/domain";
import {
  deliverDueMatches,
  recoverUnfanoutedRfqs,
  remindOverdueInvoices,
  nudgeUnratedDeals,
  rfqFanout,
  searchAlertFlush,
} from "../../src/handlers";
import { createWorkerRepo } from "../../src/repo";
import { tick } from "../../src/index";

// Isolated `*_worker_test` database — the suite drops the public schema, so
// it must never touch DATABASE_URL's dev/prod database (QA-139).
// RFQ windows must stay in the future — a past dateTo is expired by the
// sweep mid-test (QA-360).
const isoIn = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const testUrl =
  process.env.WORKER_TEST_DATABASE_URL ??
  testDatabaseUrlFrom(databaseUrl(), "_worker_test");
const { db, sql } = createDb(testUrl);
const outboxDir = mkdtempSync(join(tmpdir(), "jm-worker-outbox-"));
const email = new MockEmailProvider({ outboxDir });
const deps = (): import("../../src/handlers").WorkerDeps => ({
  repo: createWorkerRepo(db),
  sql,
  vertical: "jets",
  email,
  plans: defaultPlans(),
});

beforeAll(async () => {
  await ensureTestDatabase(testUrl);
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await runMigrations(sql);
  await seedJets(db, { storageDir: "tmp/test-storage-worker" });
});

afterAll(async () => {
  await sql.end();
});

async function insertRfq(fields: Record<string, unknown>) {
  const [row] = await db
    .insert(rfqs)
    .values({ vertical: "jets", buyerEmail: "buyer@x.com", fields })
    .returning({ id: rfqs.id });
  return row!.id;
}

describe("worker pipeline vs compose postgres + jets seed", () => {
  it("fans out an RFQ into rfq_matches and marks the rfq matched", async () => {
    const rfqId = await insertRfq({
      departure: "ZRH",
      arrival: "NCE",
      passengers: 6,
      dateFrom: isoIn(14),
      dateTo: isoIn(14),
      name: "B",
      email: "buyer@x.com",
    });
    await rfqFanout(deps(), { rfqId });

    const matches = await db
      .select()
      .from(rfqMatches)
      .where(eq(rfqMatches.rfqId, rfqId));
    expect(matches.length).toBeGreaterThan(0);
    const pending = matches.filter((m) => m.state === "pending");
    const delayed = matches.filter((m) => m.state === "delayed");
    // verified ops deliver instantly; free-plan unverified are delayed
    expect(pending.length).toBeGreaterThan(0);
    expect(delayed.length).toBeGreaterThan(0);

    const rfq = await db.select().from(rfqs).where(eq(rfqs.id, rfqId));
    expect(rfq[0]!.status).toBe("matched");

    // notification jobs enqueued for pending matches
    const jobs = await sql<{ kind: string }[]>`
      select kind from jobs where kind = 'email.quote_notification'`;
    expect(jobs.length).toBe(pending.length);
  });

  it("a concierge RFQ fans out ALL matches pending — paid instant beats plan (QA-399)", async () => {
    // The buyer can pay inside the create→claim window: the flag row-load
    // is what makes 'instant' true at fan-out time, not the operator plan.
    const rfqId = await insertRfq({
      departure: "ZRH",
      arrival: "NCE",
      passengers: 6,
      dateFrom: isoIn(14),
      dateTo: isoIn(14),
      name: "B",
      email: "buyer@x.com",
    });
    await db
      .update(rfqs)
      .set({ concierge: true })
      .where(eq(rfqs.id, rfqId));

    await rfqFanout(deps(), { rfqId });

    const matches = await db
      .select()
      .from(rfqMatches)
      .where(eq(rfqMatches.rfqId, rfqId));
    expect(matches.length).toBeGreaterThan(0);
    // free/unverified ops that would be 'delayed' on a plain RFQ are all
    // pending now — the $49 purchase can't strand them in the delay window.
    expect(matches.every((m) => m.state === "pending")).toBe(true);
    const ids = new Set(matches.map((m) => m.id));
    const jobs = await sql<{ mid: string }[]>`
      select payload::json->>'matchId' as mid from jobs
      where kind = 'email.quote_notification'`;
    // Jobs from sibling tests share the table — filter to this RFQ's matches.
    expect(jobs.map((j) => j.mid).filter((id) => ids.has(id)).sort()).toEqual(
      [...ids].sort(),
    );
  });

  it("excludes foreign-vertical dealers, keeps zero-listing brokers (QA-307)", async () => {
    // Shared-DB fan-out: a dealer whose whole book is machinery must NOT be
    // matched into a jets RFQ; an operator with no listings anywhere stays
    // eligible (the empty-fleet broker wildcard).
    const mkOp = async (emailAddr: string, name: string) => {
      const [u] = await db
        .insert(users)
        .values({ email: emailAddr })
        .returning({ id: users.id });
      const [o] = await db
        .insert(operators)
        .values({ userId: u!.id, name })
        .returning({ id: operators.id });
      return o!.id;
    };
    const machDealer = await mkOp(`mach-${randomUUID()}@x.com`, "Mach Dealer");
    await db.insert(listings).values({
      operatorId: machDealer,
      vertical: "machinery",
      type: "for_sale",
      title: "Lathe",
    });
    const broker = await mkOp(`brk-${randomUUID()}@x.com`, "Global Broker");

    // Assert on the candidate seam directly — matchOperators' top-10 cut
    // would drop the score-0 broker behind the seeded fleet operators.
    const cands = await createWorkerRepo(db).loadOperatorCandidates(
      "jets",
      undefined,
    );
    const ids = cands.map((c) => c.id);
    expect(ids).not.toContain(machDealer);
    expect(ids).toContain(broker);
    // Dealer visible to its own deploy's scan.
    const machCands = await createWorkerRepo(db).loadOperatorCandidates(
      "machinery",
      undefined,
    );
    expect(machCands.map((c) => c.id)).toContain(machDealer);
  });

  it("drops away operators from candidates but keeps their inbox (QA-427)", async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `away-${randomUUID()}@x.com` })
      .returning({ id: users.id });
    const [o] = await db
      .insert(operators)
      .values({ userId: u!.id, name: "Away Air" })
      .returning({ id: operators.id });
    // On by default — zero-listing broker wildcard applies.
    expect(
      (await createWorkerRepo(db).loadOperatorCandidates("jets", undefined))
        .map((c) => c.id),
    ).toContain(o!.id);
    await db
      .update(operators)
      .set({ acceptingRfqs: false })
      .where(eq(operators.id, o!.id));
    expect(
      (await createWorkerRepo(db).loadOperatorCandidates("jets", undefined))
        .map((c) => c.id),
    ).not.toContain(o!.id);
    await db
      .update(operators)
      .set({ acceptingRfqs: true })
      .where(eq(operators.id, o!.id));
    expect(
      (await createWorkerRepo(db).loadOperatorCandidates("jets", undefined))
        .map((c) => c.id),
    ).toContain(o!.id);
  });

  it("claims overdue invoices once, chases weekly, ignores settled deals (QA-429)", async () => {
    const tag = randomUUID().slice(0, 8);
    const [u] = await db
      .insert(users)
      .values({ email: `debtor-${tag}@x.com` })
      .returning({ id: users.id });
    const [o] = await db
      .insert(operators)
      .values({ userId: u!.id, name: "Debtor Air" })
      .returning({ id: operators.id });
    const mkDeal = async (input: {
      vertical?: string;
      invoiceStatus: "pending" | "invoiced" | "paid" | "void";
      closedAt: Date;
      invoiceRef?: string;
    }) => {
      const [l] = await db
        .insert(listings)
        .values({
          operatorId: o!.id,
          vertical: input.vertical ?? "jets",
          type: "charter",
          title: `Ctx ${tag}`,
          priceMinor: 900000,
          currency: "USD",
          status: "active",
          attributes: {},
        })
        .returning({ id: listings.id });
      const [r] = await db
        .insert(rfqs)
        .values({
          vertical: input.vertical ?? "jets",
          listingId: l!.id,
          buyerEmail: `b-${tag}@x.com`,
          fields: {},
        })
        .returning({ id: rfqs.id });
      const [q] = await db
        .insert(quotes)
        .values({
          rfqId: r!.id,
          operatorId: o!.id,
          amountMinor: 100000,
          currency: "USD",
          status: "accepted",
        })
        .returning({ id: quotes.id });
      const [d] = await db
        .insert(deals)
        .values({
          quoteId: q!.id,
          closedAt: input.closedAt,
          feePct: 0.03,
          feeAmountMinor: 3000,
          currency: "USD",
          invoiceStatus: input.invoiceStatus,
          invoiceRef: input.invoiceRef,
        })
        .returning({ id: deals.id });
      return d!.id;
    };
    const old = new Date(Date.now() - 4 * 86_400_000); // 4d > 72h window
    const overdue = await mkDeal({
      invoiceStatus: "invoiced",
      closedAt: old,
      invoiceRef: `inv_${tag}`,
    });
    // Not eligible: still-pending invoice, settled deal, fresh invoice,
    // machinery-vertical deal.
    await mkDeal({ invoiceStatus: "pending", closedAt: old });
    await mkDeal({ invoiceStatus: "paid", closedAt: old });
    await mkDeal({ invoiceStatus: "invoiced", closedAt: new Date() });
    await mkDeal({
      vertical: "machinery",
      invoiceStatus: "invoiced",
      closedAt: old,
    });

    const d = deps();
    d.invoiceReminderHours = 72;
    // Private outbox — the suite shares one dir and a later test asserts
    // every mail it holds is RFQ-related.
    const mineDir = mkdtempSync(join(tmpdir(), "jm-invoice-outbox-"));
    d.email = new MockEmailProvider({ outboxDir: mineDir });
    const claimed = await remindOverdueInvoices(d);
    expect(claimed).toBe(1);
    const mails = await readOutbox(mineDir);
    const mine = mails.filter((m) => m.to === `debtor-${tag}@x.com`);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toContain(`inv_${tag}`);
    expect(mine[0]!.subject).toContain("30");

    // Stamp written → immediate re-sweep claims nothing.
    expect(await remindOverdueInvoices(d)).toBe(0);
    // Cooldown ages out (>7d) → the chase re-arms.
    await db
      .update(deals)
      .set({ invoiceRemindedAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(deals.id, overdue));
    expect(await remindOverdueInvoices(d)).toBe(1);
    // Settling the invoice stops the chase entirely.
    await db
      .update(deals)
      .set({ invoiceStatus: "paid", invoiceRemindedAt: null })
      .where(eq(deals.id, overdue));
    expect(await remindOverdueInvoices(d)).toBe(0);
    // Teardown: leave the fixture SETTLED — the suite shares one seeded DB
    // and a leftover 'invoiced' deal would be claimed by a later tick().
    await db
      .update(deals)
      .set({ invoiceStatus: "paid" })
      .where(eq(deals.id, overdue));
  });

  it("claims unrated deals once, mails the rate link, skips rated/young/foreign (QA-456)", async () => {
    const tag = randomUUID().slice(0, 8);
    const [u] = await db
      .insert(users)
      .values({ email: `rated-op-${tag}@x.com` })
      .returning({ id: users.id });
    const [o] = await db
      .insert(operators)
      .values({ userId: u!.id, name: "Nudge Air" })
      .returning({ id: operators.id });
    const mkDeal = async (input: {
      vertical?: string;
      closedAt: Date;
      buyerRating?: number;
      ratingMailed?: boolean;
      buyerTag?: string;
    }) => {
      const [l] = await db
        .insert(listings)
        .values({
          operatorId: o!.id,
          vertical: input.vertical ?? "jets",
          type: "charter",
          title: `RateCtx ${tag}`,
          priceMinor: 900000,
          currency: "USD",
          status: "active",
          attributes: {},
        })
        .returning({ id: listings.id });
      const [r] = await db
        .insert(rfqs)
        .values({
          vertical: input.vertical ?? "jets",
          listingId: l!.id,
          buyerEmail: `${input.buyerTag ?? `b`}-${tag}@x.com`,
          fields: {},
        })
        .returning({ id: rfqs.id, accessToken: rfqs.accessToken });
      const [q] = await db
        .insert(quotes)
        .values({
          rfqId: r!.id,
          operatorId: o!.id,
          amountMinor: 100000,
          currency: "USD",
          status: "accepted",
        })
        .returning({ id: quotes.id });
      const [d] = await db
        .insert(deals)
        .values({
          quoteId: q!.id,
          closedAt: input.closedAt,
          feePct: 0.03,
          feeAmountMinor: 3000,
          currency: "USD",
          invoiceStatus: "paid",
          ...(input.buyerRating !== undefined
            ? { buyerRating: input.buyerRating }
            : {}),
          ...(input.ratingMailed
            ? { ratingMailedAt: new Date() }
            : {}),
        })
        .returning({ id: deals.id });
      return { dealId: d!.id, rfq: r! };
    };
    const old = new Date(Date.now() - 4 * 86_400_000); // 4d > 72h window
    const due = await mkDeal({ closedAt: old, buyerTag: "unrated" });
    const rated = await mkDeal({ closedAt: old, buyerRating: 5 });
    const young = await mkDeal({ closedAt: new Date() });
    const mailed = await mkDeal({ closedAt: old, ratingMailed: true });
    const foreign = await mkDeal({ closedAt: old, vertical: "machinery" });

    const d = deps();
    d.unratedNudgeHours = 72;
    const mineDir = mkdtempSync(join(tmpdir(), "jm-rating-outbox-"));
    d.email = new MockEmailProvider({ outboxDir: mineDir });

    const claimed = await nudgeUnratedDeals(d);
    // >=1, not ==1 — earlier tests leave unrated deals in the shared seed
    // and they are legitimately claimed + mailed on this sweep.
    expect(claimed).toBeGreaterThanOrEqual(1);
    const mails = await readOutbox(mineDir);
    const mine = mails.filter((m) => m.to === `unrated-${tag}@x.com`);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toContain("Nudge Air");
    expect(mine[0]!.text).toContain(
      `#t=${encodeURIComponent(due.rfq.accessToken)}`,
    );

    // Stamp persisted on every claimed row → the immediate re-sweep is
    // empty; the ineligible fixtures were never claimed either.
    expect(await nudgeUnratedDeals(d)).toBe(0);
    const stillOpen = await db
      .select({ t: deals.ratingMailedAt })
      .from(deals)
      .where(
        inArray(deals.id, [rated.dealId, young.dealId, mailed.dealId, foreign.dealId]),
      );
    // `mailed` keeps its stamp; the other three stay untouched.
    expect(stillOpen.filter((r) => r.t === null)).toHaveLength(3);

    // Teardown: stamp the leftovers a later tick() would otherwise claim —
    // and they were never stamped by the sweep itself.
    for (const fixture of [rated, young, foreign])
      await db
        .update(deals)
        .set({ ratingMailedAt: new Date() })
        .where(eq(deals.id, fixture.dealId));
  });

  it("delivers delayed matches on sweep and sends notifications end-to-end", async () => {
    const rfqId = await insertRfq({
      departure: "NCE",
      arrival: "LTN",
      passengers: 4,
      dateFrom: isoIn(15),
      dateTo: isoIn(15),
      name: "B",
      email: "buyer@x.com",
    });
    await rfqFanout(deps(), { rfqId });

    // Force all delayed matches due now.
    await db
      .update(rfqMatches)
      .set({ deliverAt: new Date(Date.now() - 1000) })
      .where(eq(rfqMatches.state, "delayed"));

    const flipped = await deliverDueMatches(deps());
    expect(flipped).toBeGreaterThan(0);

    // Claim + run notification jobs via the tick loop.
    const claimed = await tick(deps());
    expect(claimed).toBeGreaterThan(0);

    const outbox = readOutbox(outboxDir);
    expect(outbox.length).toBeGreaterThan(0);
    const opEmails = (
      await db
        .select({ email: users.email })
        .from(users)
        .innerJoin(operators, eq(users.id, operators.userId))
    ).map((u) => u.email);
    for (const m of outbox) {
      expect(opEmails).toContain(m.to);
      expect(m.subject).toContain("RFQ");
    }

    const sent = await db
      .select({ state: rfqMatches.state })
      .from(rfqMatches)
      .where(eq(rfqMatches.state, "sent"));
    expect(sent.length).toBeGreaterThan(0);
  });

  it("re-enqueues a pending match whose notification job never landed (QA-162)", async () => {
    // Simulate the crash window: match flipped to 'pending', worker died
    // before enqueueJob — no jobs row exists for it.
    const rfqId = await insertRfq({ name: "Strand", email: "s@x.com" });
    const [op] = await db
      .select({ id: operators.id })
      .from(operators)
      .limit(1);
    const [m] = await db
      .insert(rfqMatches)
      .values({
        rfqId,
        operatorId: op!.id,
        state: "pending",
        deliverAt: new Date(),
      })
      .returning({ id: rfqMatches.id });
    const stranded = await db
      .select({ id: rfqMatches.id })
      .from(rfqMatches)
      .where(eq(rfqMatches.id, m!.id));
    expect(stranded).toHaveLength(1);

    const n = await deliverDueMatches(deps());
    expect(n).toBeGreaterThan(0);

    const jobs = await sql<{ matchId: string }[]>`
      select payload ->> 'matchId' as "matchId" from jobs
      where kind = 'email.quote_notification'`;
    expect(jobs.map((j) => j.matchId)).toContain(m!.id);
  });

  it("re-enqueues fan-out for a 'new' RFQ whose job never landed (QA-168)", async () => {
    // Simulate the route's enqueueJob throwing post-write: RFQ persisted
    // at 'new' long past the grace window, no jobs row exists.
    const old = new Date(Date.now() - 10 * 60_000);
    const [stranded] = await db
      .insert(rfqs)
      .values({
        vertical: "jets",
        buyerEmail: "stranded@x.com",
        fields: { name: "Stranded" },
        createdAt: old,
      })
      .returning({ id: rfqs.id });
    // A fresh 'new' RFQ inside the grace window must NOT be touched.
    const fresh = await insertRfq({ name: "Fresh", email: "f@x.com" });

    const n = await recoverUnfanoutedRfqs(deps());
    expect(n).toBeGreaterThanOrEqual(1);

    const rows = await sql<{ rfqId: string }[]>`
      select payload ->> 'rfqId' as "rfqId" from jobs where kind = 'rfq.fanout'`;
    expect(rows.map((r) => r.rfqId)).toContain(stranded!.id);
    expect(rows.map((r) => r.rfqId)).not.toContain(fresh);
  });

  it("never delivers a delayed match whose RFQ already closed (QA-169)", async () => {
    // RFQ dies (accept/expiry/spam) while a delayed match still waits — the
    // flip must skip it so no operator gets a "new RFQ" email for a dead
    // request.
    const rfqId = await insertRfq({ name: "Dead", email: "d@x.com" });
    await db.update(rfqs).set({ status: "closed" }).where(eq(rfqs.id, rfqId));
    const [op] = await db
      .select({ id: operators.id })
      .from(operators)
      .limit(1);
    const [m] = await db
      .insert(rfqMatches)
      .values({
        rfqId,
        operatorId: op!.id,
        state: "delayed",
        deliverAt: new Date(Date.now() - 60_000), // already due
      })
      .returning({ id: rfqMatches.id });

    await deliverDueMatches(deps());

    const [after] = await db
      .select({ state: rfqMatches.state })
      .from(rfqMatches)
      .where(eq(rfqMatches.id, m!.id));
    expect(after!.state).toBe("delayed");
  });

  it("expires stale rfqs and declines their sent quotes on tick", async () => {
    const rfqId = await insertRfq({
      departure: "ZRH",
      arrival: "NCE",
      dateFrom: "2020-01-01",
      dateTo: "2020-01-02",
      email: "buyer@x.com",
    });
    const freshId = await insertRfq({
      departure: "ZRH",
      arrival: "NCE",
      dateFrom: "2999-01-01",
      dateTo: "2999-01-02",
      email: "buyer@x.com",
    });
    const [op] = await db.select({ id: operators.id }).from(operators).limit(1);
    const [staleQuote] = await db
      .insert(quotes)
      .values({
        rfqId,
        operatorId: op!.id,
        amountMinor: 10000,
        status: "sent",
      })
      .returning({ id: quotes.id });
    const [freshQuote] = await db
      .insert(quotes)
      .values({
        rfqId: freshId,
        operatorId: op!.id,
        amountMinor: 10000,
        status: "sent",
      })
      .returning({ id: quotes.id });

    await tick(deps());

    const [expired] = await db
      .select({ status: rfqs.status })
      .from(rfqs)
      .where(eq(rfqs.id, rfqId));
    expect(expired!.status).toBe("closed"); // iface "expired" -> db closed
    const [fresh] = await db
      .select({ status: rfqs.status })
      .from(rfqs)
      .where(eq(rfqs.id, freshId));
    expect(fresh!.status).not.toBe("closed");
    const [stale] = await db
      .select({ status: quotes.status })
      .from(quotes)
      .where(eq(quotes.id, staleQuote!.id));
    expect(stale!.status).toBe("declined");
    const [live] = await db
      .select({ status: quotes.status })
      .from(quotes)
      .where(eq(quotes.id, freshQuote!.id));
    expect(live!.status).toBe("sent");
  });

  it("completes a notification whose match is gone (no retry)", async () => {
    // Cascade-deleted rfq/operator or a stale payload — the email is
    // permanently undeliverable, so the job must complete, not retry.
    const jobId = await enqueueJob(sql, "email.quote_notification", {
      matchId: randomUUID(),
    });
    for (let i = 0; i < 5; i++) {
      await tick(deps());
      const row = await sql<{ status: string }[]>`
        select status from jobs where id = ${jobId}`;
      if (row[0]!.status === "done") return;
    }
    throw new Error("gone-match notification job never completed");
  });

  it("retries a bad payload to failed after max attempts", async () => {
    const jobId = await enqueueJob(sql, "email.quote_notification", {
      // missing matchId -> handler throws on payload validation
    });
    // The job competes for the claim batch with earlier notifications —
    // tick until it has been claimed and failed at least once.
    let row: { status: string; last_error: string | null }[] = [];
    for (let i = 0; i < 5; i++) {
      await tick(deps());
      row = await sql<{ status: string; last_error: string | null }[]>`
        select status, last_error from jobs where id = ${jobId}`;
      if (row[0]!.last_error) break;
    }
    expect(["pending", "failed"]).toContain(row[0]!.status);
    expect(row[0]!.last_error).toContain("matchId");
  });

  it("prunes old terminal jobs but keeps recent + pending ones", async () => {
    const mk = async (status: string, ageDays: number) => {
      const id = await enqueueJob(sql, "email.quote_notification", {
        matchId: randomUUID(),
      });
      await sql`
        update jobs set status = ${status},
               updated_at = now() - (${ageDays} || ' days')::interval
         where id = ${id}`;
      return id;
    };
    const oldDone = await mk("done", 8);
    const recentDone = await mk("done", 1);
    const oldFailed = await mk("failed", 31);
    const recentFailed = await mk("failed", 2);
    const oldPending = await mk("pending", 60);

    const pruned = await pruneJobs(sql, {
      doneOlderThan: new Date(Date.now() - 7 * 24 * 60 * 60_000),
      failedOlderThan: new Date(Date.now() - 30 * 24 * 60 * 60_000),
    });
    expect(pruned).toBeGreaterThanOrEqual(2);

    const remaining = await sql<{ id: string }[]>`
      select id from jobs where id = any(${[
        oldDone,
        recentDone,
        oldFailed,
        recentFailed,
        oldPending,
      ]})`;
    const remainingIds = new Set(remaining.map((r) => r.id));
    expect(remainingIds.has(oldDone)).toBe(false);
    expect(remainingIds.has(oldFailed)).toBe(false);
    expect(remainingIds.has(recentDone)).toBe(true);
    expect(remainingIds.has(recentFailed)).toBe(true);
    expect(remainingIds.has(oldPending)).toBe(true);
  });

  it("flushes matured saved-search backlogs as one digest (QA-403)", async () => {
    // Backlog accumulates web-side inside the mail cooldown; once the
    // window matures the tick sweep mails a single digest and clears it.
    const [listing] = await db
      .select({ id: listings.id, title: listings.title })
      .from(listings)
      .limit(1);
    const stale = new Date(Date.now() - 21 * 3_600_000);
    const fresh = new Date();
    const staleId = randomUUID();
    const freshId = randomUUID();
    const dailyOldId = randomUUID();
    const dailyNewId = randomUUID();
    await db.insert(searchAlerts).values([
      {
        id: staleId,
        vertical: "jets",
        email: "digest-buyer@x.com",
        params: { type: "charter" },
        token: `tok-${staleId}`,
        dedupeKey: `int-stale-${randomUUID()}`,
        status: "active",
        pendingIds: [listing!.id],
        lastAlertedAt: stale,
      },
      {
        id: freshId,
        vertical: "jets",
        email: "cooldown-buyer@x.com",
        params: {},
        token: `tok-${freshId}`,
        dedupeKey: `int-fresh-${randomUUID()}`,
        status: "active",
        pendingIds: [listing!.id],
        lastAlertedAt: fresh, // still inside the window — must not flush
      },
      {
        // QA-406: 'daily' rows have NULL last_alerted_at by construction —
        // the window anchors on created_at instead, else they'd flush at
        // the next tick and batch nothing.
        id: dailyOldId,
        vertical: "jets",
        email: "daily-old@x.com",
        params: {},
        token: `tok-${dailyOldId}`,
        dedupeKey: `int-daily-old-${randomUUID()}`,
        status: "active",
        pendingIds: [listing!.id],
        freq: "daily",
        createdAt: stale,
      },
      {
        id: dailyNewId,
        vertical: "jets",
        email: "daily-new@x.com",
        params: {},
        token: `tok-${dailyNewId}`,
        dedupeKey: `int-daily-new-${randomUUID()}`,
        status: "active",
        pendingIds: [listing!.id],
        freq: "daily",
        createdAt: fresh, // young subscription — holds its window
      },
    ]);

    const flushed = await searchAlertFlush(deps());
    expect(flushed).toBe(2);

    const outbox = readOutbox(outboxDir);
    const digest = outbox.find((m) => m.to === "digest-buyer@x.com");
    expect(digest).toBeDefined();
    expect(digest!.subject).toContain("saved search");
    expect(digest!.text).toContain(listing!.title);
    expect(digest!.text).toContain(`unsubscribe?token=tok-${staleId}`);
    expect(outbox.find((m) => m.to === "cooldown-buyer@x.com")).toBeUndefined();

    const [staleRow] = await db
      .select()
      .from(searchAlerts)
      .where(eq(searchAlerts.id, staleId));
    expect(staleRow!.pendingIds).toEqual([]);
    expect(staleRow!.lastAlertedAt!.getTime()).toBeGreaterThan(
      stale.getTime(),
    );
    const [freshRow] = await db
      .select()
      .from(searchAlerts)
      .where(eq(searchAlerts.id, freshId));
    expect(freshRow!.pendingIds).toEqual([listing!.id]);

    // Daily: matured-by-created_at flushes; a young subscription holds.
    expect(outbox.find((m) => m.to === "daily-old@x.com")).toBeDefined();
    expect(outbox.find((m) => m.to === "daily-new@x.com")).toBeUndefined();
    const [dailyNewRow] = await db
      .select()
      .from(searchAlerts)
      .where(eq(searchAlerts.id, dailyNewId));
    expect(dailyNewRow!.pendingIds).toEqual([listing!.id]);

    await db
      .delete(searchAlerts)
      .where(
        inArray(searchAlerts.id, [staleId, freshId, dailyOldId, dailyNewId]),
      );
  });

  it("sweeps expired dated listings once and mails the operator (QA-418)", async () => {
    // A leg whose date passed drops out of browse silently; the sweep
    // claims it once (expiry_mailed_at CAS in the same UPDATE) and the
    // handler mails a relist nudge — a second tick must not re-mail.
    const [op] = await db
      .select({ id: operators.id, userId: operators.userId })
      .from(operators)
      .limit(1);
    const [usr] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, op!.userId));
    const tag = Date.now();
    const mk = (title: string, attrs: Record<string, unknown>, status = "active") =>
      db
        .insert(listings)
        .values({
          operatorId: op!.id,
          vertical: "jets",
          type: "empty_leg",
          title,
          attributes: attrs,
          status: status as "active",
          currency: "USD",
        })
        .returning({ id: listings.id });
    const [expired] = await mk(`QA418 expired leg ${tag}`, { date: "2026-09-01" });
    const [expiredPaused] = await mk(`QA418 paused leg ${tag}`, { date: "2026-09-01" }, "paused");
    const [live] = await mk(`QA418 live leg ${tag}`, { date: isoIn(10) });
    const [charter] = await db
      .insert(listings)
      .values({
        operatorId: op!.id,
        vertical: "jets",
        type: "charter", // expiry only applies to the configured type
        title: `QA418 charter ${tag}`,
        attributes: { date: "2026-09-01" },
        status: "active",
        currency: "USD",
      })
      .returning({ id: listings.id });

    const sweep = { vertical: "jets", type: "empty_leg", attr: "date", now: new Date() };
    const claimed = await deps().repo.sweepExpiredListings(sweep);
    const ids = claimed.map((c) => c.listingId);
    expect(ids).toContain(expired!.id);
    expect(ids).not.toContain(expiredPaused!.id);
    expect(ids).not.toContain(live!.id);
    expect(ids).not.toContain(charter!.id);
    const mine = claimed.find((c) => c.listingId === expired!.id)!;
    expect(mine.operatorEmail).toBe(usr!.email);
    expect(mine.legDate).toBe("2026-09-01");

    // The claim stamped the row — a re-sweep never returns it again.
    const again = await deps().repo.sweepExpiredListings(sweep);
    expect(again.map((c) => c.listingId)).not.toContain(expired!.id);
    const [stamped] = await db
      .select({ t: listings.expiryMailedAt })
      .from(listings)
      .where(eq(listings.id, expired!.id));
    expect(stamped!.t).toBeTruthy();

    // Handler end-to-end: another expired leg → outbox mail to the operator.
    const [second] = await mk(`QA418 expired leg two ${tag}`, { date: "2026-09-02" });
    const d = deps();
    d.expiry = { type: "empty_leg", attributeKey: "date" };
    const { notifyExpiredListings } = await import("../../src/handlers");
    expect(await notifyExpiredListings(d)).toBeGreaterThanOrEqual(1);
    const outbox = readOutbox(outboxDir);
    const mail = outbox.find(
      (m) =>
        m.to === usr!.email &&
        (m.text ?? "").includes(`QA418 expired leg two ${tag}`),
    );
    expect(mail).toBeDefined();
    expect(mail!.subject).toContain("expired");

    await db
      .delete(listings)
      .where(
        inArray(listings.id, [expired!.id, expiredPaused!.id, live!.id, charter!.id, second!.id]),
      );
  });

  it("nudges the buyer once when all live quotes went stale (QA-422)", async () => {
    const ops = await db
      .select({ id: operators.id })
      .from(operators)
      .limit(2);
    const [op, op2] = ops;
    const tag = Date.now();
    const mkRfq = async (status: "new" | "quoted" | "closed") => {
      const [r] = await db
        .insert(rfqs)
        .values({
          vertical: "jets",
          buyerEmail: `nudge-${tag}@x.com`,
          status,
          fields: { dateTo: isoIn(10) },
        })
        .returning({ id: rfqs.id, accessToken: rfqs.accessToken });
      return r!;
    };
    const mkQuote = (
      rfqId: string,
      status: "sent" | "withdrawn" = "sent",
      opId = op!.id,
    ) =>
      db
        .insert(quotes)
        .values({ rfqId, operatorId: opId, amountMinor: 10000, status })
        .returning({ id: quotes.id });
    const backdate = (quoteId: string, iso: string) =>
      db.update(quotes).set({ createdAt: new Date(iso) }).where(eq(quotes.id, quoteId));

    const stale = new Date(Date.now() - 72 * 3_600_000).toISOString();
    const fresh = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h ago

    // stale-quoted: 2 sent quotes, all older than the window → claimable.
    const rfqStale = await mkRfq("quoted");
    // Two DISTINCT operators — quotes_rfq_operator_live_uniq caps one live
    // quote per operator per RFQ.
    const [q1] = await mkQuote(rfqStale.id);
    const [q2] = await mkQuote(rfqStale.id, "sent", op2!.id);
    await backdate(q1!.id, stale);
    await backdate(q2!.id, stale);

    // fresh-quoted: one stale + one fresh 'sent' — the fresh quote resets
    // the silence window, so no nudge yet.
    const rfqFresh = await mkRfq("quoted");
    const [q3] = await mkQuote(rfqFresh.id);
    const [q4] = await mkQuote(rfqFresh.id, "sent", op2!.id);
    await backdate(q3!.id, stale);
    await backdate(q4!.id, fresh);

    // dead-quoted: only a withdrawn quote — nothing live to nudge about.
    const rfqDead = await mkRfq("quoted");
    const [q5] = await mkQuote(rfqDead.id, "withdrawn");
    await backdate(q5!.id, stale);

    // open-but-quoted-less: a sent quote on a non-'quoted' rfq stays out.
    const rfqOpen = await mkRfq("new");
    const [q6] = await mkQuote(rfqOpen.id);
    await backdate(q6!.id, stale);

    const window = new Date(Date.now() - 48 * 3_600_000);
    const claimed = await deps().repo.sweepStaleQuotes({
      vertical: "jets",
      olderThan: window,
    });
    const ids = claimed.map((c) => c.rfqId);
    expect(ids).toContain(rfqStale.id);
    expect(ids).not.toContain(rfqFresh.id);
    expect(ids).not.toContain(rfqDead.id);
    expect(ids).not.toContain(rfqOpen.id);
    const mine = claimed.find((c) => c.rfqId === rfqStale.id)!;
    expect(mine.quoteCount).toBe(2);
    expect(mine.buyerEmail).toBe(`nudge-${tag}@x.com`);
    expect(mine.accessToken).toBe(rfqStale.accessToken);

    // Once-only: the claim stamped quote_nudge_mailed_at — re-sweep misses.
    expect(
      (await deps().repo.sweepStaleQuotes({ vertical: "jets", olderThan: window }))
        .map((c) => c.rfqId),
    ).not.toContain(rfqStale.id);
    const [stamped] = await db
      .select({ t: rfqs.quoteNudgeMailedAt })
      .from(rfqs)
      .where(eq(rfqs.id, rfqStale.id));
    expect(stamped!.t).toBeTruthy();

    // Handler end-to-end: a second stale-quoted RFQ → outbox mail to buyer.
    const rfqMail = await mkRfq("quoted");
    const [q7] = await mkQuote(rfqMail.id);
    await backdate(q7!.id, stale);
    const { nudgeStaleQuotes } = await import("../../src/handlers");
    expect(await nudgeStaleQuotes(deps())).toBeGreaterThanOrEqual(1);
    const outbox = readOutbox(outboxDir);
    const mail = outbox.find(
      (m) =>
        m.to === `nudge-${tag}@x.com` &&
        (m.text ?? "").includes("/quotes?email="),
    );
    expect(mail).toBeDefined();
    expect(mail!.subject).toContain("quote");
    expect(mail!.text).toContain(`#t=${encodeURIComponent(rfqMail.accessToken)}`);

    await db.delete(quotes).where(inArray(quotes.id, [q1!.id, q2!.id, q3!.id, q4!.id, q5!.id, q6!.id, q7!.id]));
    await db.delete(rfqs).where(inArray(rfqs.id, [rfqStale.id, rfqFresh.id, rfqDead.id, rfqOpen.id, rfqMail.id]));
  });

  it("nudges the buyer once when no quotes ever landed (QA-423)", async () => {
    const ops = await db.select({ id: operators.id }).from(operators).limit(3);
    const [op, op2, op3] = ops;
    const tag = Date.now();
    const mkRfq = async (status: "new" | "matched" | "quoted" | "closed", iso: string) => {
      const [r] = await db
        .insert(rfqs)
        .values({
          vertical: "jets",
          buyerEmail: `unquoted-${tag}@x.com`,
          status,
          createdAt: new Date(iso),
          fields: { dateTo: isoIn(10) },
        })
        .returning({ id: rfqs.id, accessToken: rfqs.accessToken });
      return r!;
    };
    const mkMatch = (rfqId: string, state: "delayed" | "pending" = "pending", opId = op!.id) =>
      db
        .insert(rfqMatches)
        .values({ rfqId, operatorId: opId, state, deliverAt: new Date() })
        .returning({ id: rfqMatches.id });

    const old = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const fresh = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h ago

    // matched + quote-less + past window, 2 live matches + 1 delayed —
    // delayed isn't delivered yet, so matchCount counts only 2.
    const rfqQuiet = await mkRfq("matched", old);
    const [m1] = await mkMatch(rfqQuiet.id);
    const [m2] = await mkMatch(rfqQuiet.id, "pending", op2!.id);
    const [m3] = await mkMatch(rfqQuiet.id, "delayed", op3!.id);

    // Fresh 'matched' — inside the window.
    const rfqFresh = await mkRfq("matched", fresh);

    // 'quoted' status gate — QA-422's sweep owns this row.
    const rfqQuoted = await mkRfq("quoted", old);

    // 'closed' terminal — no nudge to a dead request.
    const rfqClosed = await mkRfq("closed", old);

    // Quote-less in name only: a live 'sent' quote exists → not quote-less.
    const rfqHasQuote = await mkRfq("new", old);
    await db.insert(quotes).values({
      rfqId: rfqHasQuote.id,
      operatorId: op!.id,
      amountMinor: 10000,
      status: "sent",
    });

    const window = new Date(Date.now() - 24 * 3_600_000);
    const claimed = await deps().repo.sweepUnquotedRfqs({
      vertical: "jets",
      olderThan: window,
    });
    const ids = claimed.map((c) => c.rfqId);
    expect(ids).toContain(rfqQuiet.id);
    expect(ids).not.toContain(rfqFresh.id);
    expect(ids).not.toContain(rfqQuoted.id);
    expect(ids).not.toContain(rfqClosed.id);
    expect(ids).not.toContain(rfqHasQuote.id);
    const mine = claimed.find((c) => c.rfqId === rfqQuiet.id)!;
    expect(mine.matchCount).toBe(2); // delayed match excluded
    expect(mine.buyerEmail).toBe(`unquoted-${tag}@x.com`);
    expect(mine.accessToken).toBe(rfqQuiet.accessToken);

    // Once-only: stamp persisted, re-sweep misses.
    const [stamped] = await db
      .select({ t: rfqs.noQuotesMailedAt })
      .from(rfqs)
      .where(eq(rfqs.id, rfqQuiet.id));
    expect(stamped!.t).toBeTruthy();
    expect(
      (await deps().repo.sweepUnquotedRfqs({ vertical: "jets", olderThan: window }))
        .map((c) => c.rfqId),
    ).not.toContain(rfqQuiet.id);

    // Handler end-to-end: a second quiet RFQ → branded outbox mail.
    const rfqMail = await mkRfq("matched", old);
    const { nudgeUnquotedRfqs } = await import("../../src/handlers");
    expect(await nudgeUnquotedRfqs(deps())).toBeGreaterThanOrEqual(1);
    const outbox = readOutbox(outboxDir);
    const mail = outbox.find(
      (m) =>
        m.to === `unquoted-${tag}@x.com` &&
        (m.subject ?? "").includes("still gathering"),
    );
    expect(mail).toBeDefined();
    expect(mail!.text).toContain(`#t=${encodeURIComponent(rfqMail.accessToken)}`);

    await db.delete(rfqMatches).where(inArray(rfqMatches.id, [m1!.id, m2!.id, m3!.id]));
    await db.delete(quotes).where(eq(quotes.rfqId, rfqHasQuote.id));
    await db.delete(rfqs).where(
      inArray(rfqs.id, [rfqQuiet.id, rfqFresh.id, rfqQuoted.id, rfqClosed.id, rfqHasQuote.id, rfqMail.id]),
    );
  });

  it("nudges the buyer once when a live request enters its liveness window (QA-447)", async () => {
    const [op] = await db.select({ id: operators.id }).from(operators).limit(1);
    const tag = Date.now();
    const mkRfq = async (
      status: "new" | "matched" | "quoted" | "closed",
      fields: Record<string, unknown>,
      createdAt?: Date,
      vertical = "jets",
    ) => {
      const [r] = await db
        .insert(rfqs)
        .values({
          vertical,
          buyerEmail: `closing-${tag}@x.com`,
          status,
          fields,
          ...(createdAt ? { createdAt } : {}),
        })
        .returning({ id: rfqs.id, accessToken: rfqs.accessToken });
      return r!;
    };
    const day = 24 * 3_600_000;
    // Deadline math (QA-442): dated rows die at dateTo+1d, undated at
    // createdAt+30d. The sweep claims horizons inside [now, +72h].
    const rfqDatedIn = await mkRfq("quoted", { dateTo: isoIn(2) }); // dies +3d
    const rfqDyingToday = await mkRfq("matched", { dateTo: isoIn(-1) }); // dies today
    const rfqDatedOut = await mkRfq("quoted", { dateTo: isoIn(10) }); // +11d
    const rfqDeadUnswept = await mkRfq("new", { dateTo: isoIn(-3) }); // horizon -2d — expired mail's row
    const rfqUndatedIn = await mkRfq("new", {}, new Date(Date.now() - 28 * day)); // horizon +2d
    const rfqUndatedOut = await mkRfq("new", {}, new Date(Date.now() - 5 * day)); // +25d
    const rfqUndatedDead = await mkRfq("new", {}, new Date(Date.now() - 35 * day)); // horizon -5d
    const rfqClosed = await mkRfq("closed", { dateTo: isoIn(2) });
    const rfqMachinery = await mkRfq("matched", { dateTo: isoIn(2) }, undefined, "machinery");
    const [staleQuote] = await db
      .insert(quotes)
      .values({ rfqId: rfqDatedIn.id, operatorId: op!.id, amountMinor: 42000, status: "sent" })
      .returning({ id: quotes.id });

    const dyingBefore = new Date(Date.now() + 72 * 3_600_000);
    const claimed = await deps().repo.sweepClosingSoonRfqs({ vertical: "jets", dyingBefore });
    const ids = claimed.map((c) => c.rfqId);
    expect(ids).toEqual(
      expect.arrayContaining([rfqDatedIn.id, rfqDyingToday.id, rfqUndatedIn.id]),
    );
    for (const out of [rfqDatedOut, rfqDeadUnswept, rfqUndatedOut, rfqUndatedDead, rfqClosed, rfqMachinery])
      expect(ids).not.toContain(out.id);
    const mine = claimed.find((c) => c.rfqId === rfqDatedIn.id)!;
    expect(mine.quoteCount).toBe(1);
    // closesOn echoes the QA-442 horizon — dated rows show dateTo+1d.
    expect(mine.closesOn).toBe(
      new Date(new Date(`${isoIn(2)}T00:00:00.000Z`).getTime() + day)
        .toISOString()
        .slice(0, 10),
    );

    // Once-only: stamp persisted, re-sweep misses.
    const [stamped] = await db
      .select({ t: rfqs.closingMailedAt })
      .from(rfqs)
      .where(eq(rfqs.id, rfqDatedIn.id));
    expect(stamped!.t).toBeTruthy();
    expect(
      (await deps().repo.sweepClosingSoonRfqs({ vertical: "jets", dyingBefore }))
        .map((c) => c.rfqId),
    ).not.toContain(rfqDatedIn.id);

    // Handler end-to-end: a fresh in-window RFQ → branded outbox mail.
    const rfqMail = await mkRfq("matched", { dateTo: isoIn(2) });
    const { nudgeClosingSoonRfqs } = await import("../../src/handlers");
    expect(await nudgeClosingSoonRfqs(deps())).toBeGreaterThanOrEqual(1);
    const outbox = readOutbox(outboxDir);
    const mail = outbox.find(
      (m) => m.to === `closing-${tag}@x.com` && (m.subject ?? "").includes("closes"),
    );
    expect(mail).toBeDefined();
    expect(mail!.text).toContain(`#t=${encodeURIComponent(rfqMail.accessToken)}`);

    await db.delete(quotes).where(eq(quotes.id, staleQuote!.id));
    await db.delete(rfqs).where(
      inArray(rfqs.id, [
        rfqDatedIn.id, rfqDyingToday.id, rfqDatedOut.id, rfqDeadUnswept.id,
        rfqUndatedIn.id, rfqUndatedOut.id, rfqUndatedDead.id, rfqClosed.id,
        rfqMachinery.id, rfqMail.id,
      ]),
    );
  });

  it("digests operators with live unanswered RFQs, weekly at most (QA-425)", async () => {
    const ops = await db
      .select({ id: operators.id, userId: operators.userId })
      .from(operators)
      .limit(8);
    const [opA, opB, opC, opD, opE, opF] = ops;
    const tag = Date.now();
    const mkRfq = async (status: "new" | "matched" | "closed", iso: string) => {
      const [r] = await db
        .insert(rfqs)
        .values({
          vertical: "jets",
          buyerEmail: `unans-${tag}@x.com`,
          status,
          createdAt: new Date(iso),
          fields: { dateTo: isoIn(10) },
        })
        .returning({ id: rfqs.id });
      return r!;
    };
    const mkMatch = (rfqId: string, operatorId: string, state: "delayed" | "pending" = "pending") =>
      db
        .insert(rfqMatches)
        .values({ rfqId, operatorId, state, deliverAt: new Date() })
        .returning({ id: rfqMatches.id });

    const old = new Date(Date.now() - 96 * 3_600_000).toISOString(); // 4d
    const fresh = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h

    // opA: two old unanswered RFQs → count 2.
    const a1 = await mkRfq("matched", old);
    const a2 = await mkRfq("matched", old);
    const [m1] = await mkMatch(a1.id, opA!.id);
    const [m2] = await mkMatch(a2.id, opA!.id);

    // opB: old RFQ but ALREADY QUOTED — answered, no nudge.
    const b1 = await mkRfq("matched", old);
    const [m3] = await mkMatch(b1.id, opB!.id);
    await db.insert(quotes).values({
      rfqId: b1.id,
      operatorId: opB!.id,
      amountMinor: 10000,
      status: "sent",
    });

    // opC: only a delayed match — not delivered, not theirs to answer yet.
    const c1 = await mkRfq("matched", old);
    const [m4] = await mkMatch(c1.id, opC!.id, "delayed");

    // opD: old RFQ but DISMISSED — deliberate triage, no nudge.
    const d1 = await mkRfq("matched", old);
    const [m5] = await mkMatch(d1.id, opD!.id);
    await sql`insert into rfq_dismissals (rfq_id, operator_id) values (${d1.id}, ${opD!.id})`;

    // opE: match on a FRESH RFQ — inside the window.
    const e1 = await mkRfq("matched", fresh);
    const [m6] = await mkMatch(e1.id, opE!.id);

    const window = new Date(Date.now() - 72 * 3_600_000);
    const cooldown = new Date(Date.now() - 7 * 86_400_000);
    const sweep = () =>
      deps().repo.sweepUnansweredOperators({
        vertical: "jets",
        olderThan: window,
        cooldown,
      });
    const claimed = (await sweep()).filter((r) =>
      ops.some((o) => o.id === r.operatorId),
    );
    const ids = claimed.map((c) => c.operatorId);
    expect(ids).toContain(opA!.id);
    expect(ids).not.toContain(opB!.id);
    expect(ids).not.toContain(opC!.id);
    expect(ids).not.toContain(opD!.id);
    expect(ids).not.toContain(opE!.id);
    expect(claimed.find((c) => c.operatorId === opA!.id)!.unansweredCount).toBe(2);

    // Cooldown: stamp persists; a second sweep inside the week misses opA.
    const [stamped] = await db
      .select({ t: operators.unansweredMailedAt })
      .from(operators)
      .where(eq(operators.id, opA!.id));
    expect(stamped!.t).toBeTruthy();
    expect((await sweep()).map((c) => c.operatorId)).not.toContain(opA!.id);

    // Handler end-to-end: opF qualifies → branded mail to their user email.
    const f1 = await mkRfq("matched", old);
    const [m7] = await mkMatch(f1.id, opF!.id);
    const [opFUser] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, opF!.userId));
    const { nudgeUnansweredOperators } = await import("../../src/handlers");
    expect(await nudgeUnansweredOperators(deps())).toBeGreaterThanOrEqual(1);
    const outbox = readOutbox(outboxDir);
    const mail = outbox.find(
      (m) =>
        m.to === opFUser!.email &&
        (m.subject ?? "").includes("waiting for your quote"),
    );
    expect(mail).toBeDefined();
    expect(mail!.text).toContain("/app/rfqs?f=needs");

    await db.delete(rfqMatches).where(inArray(rfqMatches.id, [m1!.id, m2!.id, m3!.id, m4!.id, m5!.id, m6!.id, m7!.id]));
    await sql`delete from rfq_dismissals where rfq_id = ${d1.id}`;
    await db.delete(quotes).where(eq(quotes.rfqId, b1.id));
    await db.delete(rfqs).where(inArray(rfqs.id, [a1.id, a2.id, b1.id, c1.id, d1.id, e1.id, f1.id]));
    // The stamps are per-operator — restore them so other suites' seeds stay
    // untouched (QA-139 isolation).
    await sql`update operators set unanswered_mailed_at = null where id in (${opA!.id}, ${opF!.id})`;
  });

  it("two concurrent claimers never claim the same job (SKIP LOCKED)", async () => {
    // Scale-out safety: two workers polling the same queue must partition
    // the pending set, not duplicate it. Serial tests can't prove the
    // FOR UPDATE SKIP LOCKED actually blocks a second claimer.
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        enqueueJob(sql, "email.quote_notification", { matchId: `race-${i}` }),
      ),
    );
    const [a, b] = await Promise.all([
      claimJobs(sql, ["email.quote_notification"], 10),
      claimJobs(sql, ["email.quote_notification"], 10),
    ]);
    const aIds = new Set(a.map((j) => j.id));
    const bIds = new Set(b.map((j) => j.id));
    for (const id of ids) {
      expect(aIds.has(id) || bIds.has(id)).toBe(true);
      expect(aIds.has(id) && bIds.has(id)).toBe(false);
    }
  });
});
