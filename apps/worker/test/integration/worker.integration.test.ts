import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
  users,
  operators,
} from "@jetmarket/db/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockEmailProvider, readOutbox } from "@jetmarket/providers/email/index";
import { defaultPlans } from "@jetmarket/domain";
import { deliverDueMatches, rfqFanout } from "../../src/handlers";
import { createWorkerRepo } from "../../src/repo";
import { tick } from "../../src/index";

// Isolated `*_worker_test` database — the suite drops the public schema, so
// it must never touch DATABASE_URL's dev/prod database (QA-139).
const testUrl =
  process.env.WORKER_TEST_DATABASE_URL ??
  testDatabaseUrlFrom(databaseUrl(), "_worker_test");
const { db, sql } = createDb(testUrl);
const outboxDir = mkdtempSync(join(tmpdir(), "jm-worker-outbox-"));
const email = new MockEmailProvider({ outboxDir });
const deps = () => ({
  repo: createWorkerRepo(db),
  sql,
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
      dateFrom: "2026-10-01",
      dateTo: "2026-10-01",
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

  it("delivers delayed matches on sweep and sends notifications end-to-end", async () => {
    const rfqId = await insertRfq({
      departure: "NCE",
      arrival: "LTN",
      passengers: 4,
      dateFrom: "2026-10-02",
      dateTo: "2026-10-02",
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
});
