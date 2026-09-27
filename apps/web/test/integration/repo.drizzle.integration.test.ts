/**
 * Repo contract vs live Postgres. Uses TEST_DATABASE_URL (default:
 * jetmarket_test from docker-compose). The whole schema is dropped + rebuilt
 * by migrations in beforeAll — never point this at a database you care about.
 * Skips cleanly when Postgres is unreachable (CI without compose).
 */
import { createDb, runMigrations, schema, type DbClient } from "@jetmarket/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DrizzleRepo } from "../../lib/repo/drizzle";
import { repoContract } from "./repo.contract";

const url =
  process.env.TEST_DATABASE_URL ??
  "postgres://jetmarket:jetmarket@localhost:5432/jetmarket_test";

// Probe once at module load so unreachable Postgres skips instead of failing.
const probe = createDb(url);
const reachable = await probe.sql`select 1`
  .then(() => true)
  .catch(() => false)
  .finally(() => probe.sql.end());

let client: DbClient | undefined;

beforeAll(async () => {
  if (!reachable) return;
  client = createDb(url);
  await client.sql`drop schema public cascade`;
  await client.sql`create schema public`;
  await runMigrations(client.sql);
}, 30_000);

afterAll(async () => {
  await client?.sql.end();
});

describe.skipIf(!reachable)(
  `Repo contract vs Postgres (${reachable ? url : "unreachable"})`,
  () => {
    repoContract("drizzle", async () => new DrizzleRepo(client!.db));
  },
);

// QA-18: the quotes unique index is partial — one *live* quote per
// (rfq, operator); terminal statuses free the pair for a re-quote.
describe.skipIf(!reachable)("quotes partial-unique (QA-18)", () => {
  const { quotes, rfqs, operators, users } = schema;
  const isUnique = (e: unknown) =>
    (e as { code?: string }).code === "23505" ||
    (e as { cause?: { code?: string } }).cause?.code === "23505";

  it("blocks a second live quote, allows re-quote after decline", async () => {
    const db = client!.db;
    const [u] = await db
      .insert(users)
      .values({ email: `uq-${Date.now()}@test.dev`, role: "operator" })
      .returning();
    const [op] = await db
      .insert(operators)
      .values({ userId: u!.id, name: "UQ Air", plan: "pro" })
      .returning();
    const [rfq] = await db
      .insert(rfqs)
      .values({
        vertical: "jets",
        buyerEmail: `uq-${Date.now()}@test.dev`,
        fields: {},
      })
      .returning();

    const insertQuote = (status: (typeof quotes.$inferInsert)["status"]) =>
      db.insert(quotes).values({
        rfqId: rfq!.id,
        operatorId: op!.id,
        amountMinor: 10000,
        status,
      });

    await insertQuote("sent");
    // second live quote for the same pair violates the partial unique
    await expect(insertQuote("sent")).rejects.toSatisfy(isUnique);
    // 'accepted' counts as live too
    await expect(insertQuote("accepted")).rejects.toSatisfy(isUnique);

    // decline the live quote -> the pair is free again
    const [live] = await db
      .select({ id: quotes.id })
      .from(quotes)
      .where(eq(quotes.rfqId, rfq!.id))
      .limit(1);
    await db
      .update(quotes)
      .set({ status: "declined" })
      .where(eq(quotes.id, live!.id));
    await insertQuote("sent"); // no throw — re-quote path
  });
});


// QA-65: a delivered (pending) rfq_match makes the RFQ inbox-visible and
// quotable for the matched operator — the owner OR the match holder.
describe.skipIf(!reachable)("fan-out match inbox visibility (QA-65)", () => {
  const { rfqs, rfqMatches, operators, users, listings } = schema;

  it("pending match sees the rfq; delayed does not; both can/cannot quote accordingly", async () => {
    const db = client!.db;
    const repo = new DrizzleRepo(db);
    const tag = Date.now().toString(36);

    const [u] = await db
      .insert(users)
      .values({ email: `q65-${tag}@test.dev`, role: "operator" })
      .returning();
    const [op] = await db
      .insert(operators)
      .values({ userId: u!.id, name: "Q65 Air", plan: "pro" })
      .returning();
    const [l] = await db
      .insert(listings)
      .values({
        operatorId: op!.id,
        vertical: "jets",
        type: "charter",
        title: `Q65 ${tag}`,
        priceMinor: 100,
        status: "active",
      })
      .returning();
    const [rfq] = await db
      .insert(rfqs)
      .values({
        vertical: "jets",
        listingId: l!.id,
        buyerEmail: `b-${tag}@test.dev`,
        fields: {},
        status: "new",
      })
      .returning();

    // a second operator matched via fan-out (pending = delivered)
    const [u2] = await db
      .insert(users)
      .values({ email: `q65b-${tag}@test.dev`, role: "operator" })
      .returning();
    const [op2] = await db
      .insert(operators)
      .values({ userId: u2!.id, name: "Q65 B Air", plan: "free" })
      .returning();
    await db.insert(rfqMatches).values({
      rfqId: rfq!.id,
      operatorId: op2!.id,
      listingId: l!.id,
      state: "pending",
    });

    expect(await repo.hasRfqMatch(rfq!.id, op2!.id)).toBe(true);
    const inbox2 = await repo.listRfqs({ operatorId: op2!.id });
    expect(inbox2.map((r) => r.id)).toContain(rfq!.id);

    // delayed match is NOT yet visible
    const [u3] = await db
      .insert(users)
      .values({ email: `q65c-${tag}@test.dev`, role: "operator" })
      .returning();
    const [op3] = await db
      .insert(operators)
      .values({ userId: u3!.id, name: "Q65 C Air", plan: "free" })
      .returning();
    await db.insert(rfqMatches).values({
      rfqId: rfq!.id,
      operatorId: op3!.id,
      listingId: l!.id,
      state: "delayed",
    });
    expect(await repo.hasRfqMatch(rfq!.id, op3!.id)).toBe(false);
    const inbox3 = await repo.listRfqs({ operatorId: op3!.id });
    expect(inbox3.map((r) => r.id)).not.toContain(rfq!.id);
  });
});
