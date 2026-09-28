/**
 * Guardrails for integration tests that drop the public schema. A bare
 * `jetmarket` URL is dev/prod data — `drop schema public cascade` against it
 * destroys seeded state and queued jobs (it nuked the dev DB mid-suite once:
 * QA-139). Suites default to a dedicated `*_test` database, created on demand,
 * and refuse anything that isn't clearly a test database.
 */
import postgres from "postgres";

function dbName(url: string): string {
  return new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
}

/** The admin database is always present on a postgres server. */
function adminUrlFor(url: string): string {
  const u = new URL(url);
  u.pathname = "/postgres";
  return u.toString();
}

/** Same URL with the database name replaced. */
function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/**
 * Throw unless `url` points at a database whose name ends in `_test`.
 * `ALLOW_DESTRUCTIVE_TEST_DB=1` overrides (e.g. a disposable scratch db that
 * doesn't follow the convention).
 */
export function assertTestDatabaseUrl(url: string): void {
  if (process.env.ALLOW_DESTRUCTIVE_TEST_DB === "1") return;
  const name = dbName(url);
  if (!name.endsWith("_test")) {
    throw new Error(
      `integration tests drop the public schema — refusing database "${name || url}" ` +
        `(expected a *_test database; set ALLOW_DESTRUCTIVE_TEST_DB=1 to override)`,
    );
  }
}

/** `<base>_test` URL from an app URL (e.g. …/jetmarket → …/jetmarket_test). */
export function testDatabaseUrlFrom(url: string, suffix?: string): string {
  return withDbName(url, `${dbName(url) || "jetmarket"}${suffix ?? "_test"}`);
}

/**
 * Create the test database if it doesn't exist yet, then assert the name is
 * safe to drop. Call once before migrating/dropping the schema.
 */
export async function ensureTestDatabase(url: string): Promise<void> {
  assertTestDatabaseUrl(url);
  const name = dbName(url);
  const sql = postgres(adminUrlFor(url), { max: 1, connect_timeout: 10 });
  try {
    const existing =
      await sql`select 1 from pg_database where datname = ${name}`;
    if (!existing.length) {
      await sql.unsafe(`create database "${name}"`);
    }
  } finally {
    await sql.end();
  }
}
