/**
 * Minimal SQL migration runner. Applies `migrations/*.sql` in lexical order
 * inside per-file transactions, recording each in `_migrations`. Idempotent
 * by ledger (and our migrations are IF NOT EXISTS anyway).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "./client";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(
  sql: Sql,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  await sql`
    create table if not exists _migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const applied = new Set(
    (
      await sql<{ name: string }[]>`select name from _migrations order by name`
    ).map((r) => r.name),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const result: MigrationResult = { applied: [], skipped: [] };
  for (const file of files) {
    if (applied.has(file)) {
      result.skipped.push(file);
      continue;
    }
    const body = readFileSync(join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into _migrations (name) values (${file})`;
    });
    result.applied.push(file);
  }
  return result;
}
