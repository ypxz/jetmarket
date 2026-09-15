/**
 * Integration test vs the compose Postgres (`pnpm db:up`). Runs migrations,
 * the idempotent jets seed, a job-claim cycle, and the RFQ→match→quote→deal
 * foreign-key chain. Set DATABASE_URL to point elsewhere to reuse.
 */
import { eq, sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, databaseUrl, type DbClient } from "../../src/client";
import { claimJobs, completeJob, enqueueJob, failJob } from "../../src/jobs";
import { runMigrations } from "../../src/migrate";
import {
  deals,
  listings,
  operators,
  quotes,
  rfqMatches,
  rfqs,
} from "../../src/schema";
import { seedJets } from "../../src/seed/jets";

let client: DbClient;

beforeAll(async () => {
  client = createDb(databaseUrl());
  // Fresh slate: drop everything so the migration proves it builds from zero.
  await client.sql`drop schema public cascade`;
  await client.sql`create schema public`;
  await runMigrations(client.sql);
});

afterAll(async () => {
  await client.sql.end();
});

describe("migrations", () => {
  it("builds all tables and is idempotent", async () => {
    const tables = await client.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
       where table_schema = 'public' order by table_name
    `;
    const names = tables.map((t) => t.table_name);
    for (const t of [
      "users",
      "operators",
      "listings",
      "rfqs",
      "rfq_matches",
      "quotes",
      "deals",
      "subscriptions",
      "usage",
      "jobs",
      "_migrations",
    ]) {
      expect(names).toContain(t);
    }
    const second = await runMigrations(client.sql);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain("0001_init.sql");
  });
});

describe("jets seed", () => {
  it("inserts 15 operators and 60 listings, idempotent on re-run", async () => {
    const first = await seedJets(client.db, {
      storageDir: "tmp/test-storage",
      now: new Date("2026-09-15T00:00:00Z"),
    });
    expect(first.operators).toBe(15);
    expect(first.listings).toBe(60);

    const counts = await client.db
      .select({ n: dsql<number>`count(*)::int` })
      .from(listings);
    expect(counts[0]!.n).toBe(60);

    const second = await seedJets(client.db, {
      storageDir: "tmp/test-storage",
      now: new Date("2026-09-16T00:00:00Z"),
    });
    expect(second.listings).toBe(60);
    const after = await client.db
      .select({ n: dsql<number>`count(*)::int` })
      .from(listings);
    expect(after[0]!.n).toBe(60); // upsert, not duplicate
  });

  it("seeds verified/pro mix + active listings", async () => {
    const ops = await client.db.select().from(operators);
    expect(ops.filter((o) => o.verified).length).toBeGreaterThanOrEqual(8);
    expect(ops.filter((o) => o.plan === "pro").length).toBe(5);
    const active = await client.db
      .select({ n: dsql<number>`count(*)::int` })
      .from(listings)
      .where(eq(listings.status, "active"));
    expect(active[0]!.n).toBe(60);
  });
});

describe("jobs queue", () => {
  it("enqueues, claims (skip-locked), completes, and retries on failure", async () => {
    const { sql } = client;
    const futureId = await enqueueJob(sql, "email.quote_notification", {
      quoteId: "q",
    }, { runAt: new Date(Date.now() + 3_600_000) });
    const now = await enqueueJob(sql, "rfq.fanout", { rfqId: "r1" });

    const claimed = await claimJobs(sql, ["rfq.fanout", "email.quote_notification"]);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.id).toBe(now); // future job not yet due
    expect(claimed[0]!.status).toBe("running");
    expect(claimed[0]!.attempts).toBe(1);

    // Second claim sees nothing pending.
    expect(await claimJobs(sql, ["rfq.fanout"])).toHaveLength(0);

    await failJob(sql, now, "boom", 1); // attempts 1 < max 5 -> requeued w/ 1ms backoff
    const claimed2 = await claimJobs(
      sql,
      ["rfq.fanout"],
      10,
      new Date(Date.now() + 5_000), // tolerate sub-ms backoff delay
    );
    expect(claimed2.map((j) => j.id)).toContain(now);
    await failJob(sql, now, "boom", 0); // attempts=2 -> back to pending

    // Exhaust attempts -> failed. attempts increments only on claim.
    const horizon = new Date(Date.now() + 60_000);
    for (let i = 0; i < 5; i++) {
      const c = await claimJobs(sql, ["rfq.fanout"], 10, horizon);
      const j = c.find((x) => x.id === now);
      if (!j) break;
      await failJob(sql, now, "boom", 0);
    }
    const row = await sql<{ status: string; attempts: number }[]>`
      select status, attempts from jobs where id = ${now}`;
    expect(row[0]!.status).toBe("failed");
    expect(row[0]!.attempts).toBe(5);

    await completeJob(sql, futureId);
    const done = await sql<{ status: string }[]>`
      select status from jobs where id = ${futureId}`;
    expect(done[0]!.status).toBe("done");
  });
});

describe("rfq -> match -> quote -> deal chain", () => {
  it("persists the full deal flow", async () => {
    const { db } = client;
    const [listing] = await db
      .select()
      .from(listings)
      .where(eq(listings.type, "empty_leg"))
      .limit(1);
    const [rfq] = await db
      .insert(rfqs)
      .values({
        vertical: "jets",
        listingId: listing!.id,
        buyerEmail: "buyer@example.com",
        fields: {
          departure: "ZRH",
          arrival: "NCE",
          passengers: 4,
          dateFrom: "2026-10-01",
          dateTo: "2026-10-01",
          email: "buyer@example.com",
          name: "Test Buyer",
        },
        status: "matched",
      })
      .returning();

    const [match] = await db
      .insert(rfqMatches)
      .values({
        rfqId: rfq!.id,
        operatorId: listing!.operatorId,
        listingId: listing!.id,
        state: "sent",
      })
      .returning();

    const [quote] = await db
      .insert(quotes)
      .values({
        rfqId: rfq!.id,
        operatorId: match!.operatorId,
        amountMinor: 940_000, // $9,400

        currency: "USD",
        message: "Aircraft available, crewed.",
        status: "accepted",
      })
      .returning();

    const [deal] = await db
      .insert(deals)
      .values({
        quoteId: quote!.id,
        closedAt: new Date(),
        feePct: 3,
        feeAmountMinor: 28_200, // 3% of 940_000

        currency: "USD",
        invoiceStatus: "pending",
      })
      .returning();

    expect(deal!.feeAmountMinor).toBe(28_200);
    expect(deal!.quoteId).toBe(quote!.id);

    // Duplicate match is rejected by the unique constraint.
    await expect(
      db.insert(rfqMatches).values({
        rfqId: rfq!.id,
        operatorId: match!.operatorId,
      }),
    ).rejects.toThrow();
  });
});
