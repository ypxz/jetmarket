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
