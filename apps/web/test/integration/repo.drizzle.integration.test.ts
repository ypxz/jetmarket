/**
 * Repo contract vs live Postgres. Uses TEST_DATABASE_URL (default:
 * jetmarket_test from docker-compose). The whole schema is dropped + rebuilt
 * by migrations in beforeAll — never point this at a database you care about.
 * Skips cleanly when Postgres is unreachable (CI without compose).
 */
import { createDb, runMigrations, type DbClient } from "@jetmarket/db";
import { afterAll, beforeAll, describe } from "vitest";
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
