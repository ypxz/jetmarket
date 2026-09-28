/**
 * CLI: `pnpm --filter @jetmarket/db check:parity` — diffs `schema.ts`
 * (drizzle declarations) against the live database (information_schema).
 *
 * Hand-written migrations + hand-maintained schema.ts drift silently:
 * a column declared here but never migrated crashes only in prod; a column
 * migrated but never declared is invisible to every query. This check pins
 * table presence, column sets, and nullability both directions.
 *
 * The bookkeeping `_migrations` table is excluded. Defaults to the compose
 * dev DB — point DATABASE_URL at any migrated schema.
 */
import { getTableColumns, getTableName, is, Table } from "drizzle-orm";
import { createDb, databaseUrl } from "../client";
import * as schema from "../schema";

const INTERNAL_TABLES = new Set(["_migrations"]);

interface DbColumn {
  table_name: string;
  column_name: string;
  is_nullable: "YES" | "NO";
}

const { sql } = createDb(databaseUrl());
try {
  const rows = await sql<DbColumn[]>`
    select table_name, column_name, is_nullable
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, column_name
  `;

  const dbTables = new Map<string, Map<string, DbColumn>>();
  for (const r of rows) {
    if (INTERNAL_TABLES.has(r.table_name)) continue;
    const cols = dbTables.get(r.table_name) ?? new Map<string, DbColumn>();
    cols.set(r.column_name, r);
    dbTables.set(r.table_name, cols);
  }

  const problems: string[] = [];
  const seen = new Set<string>();

  for (const value of Object.values(schema)) {
    if (!is(value, Table)) continue;
    const table = value as Table;
    const tName = getTableName(table);
    seen.add(tName);
    const declared = getTableColumns(table);
    const declaredBySqlName = new Map(
      Object.values(declared).map((c) => [c.name, c] as const),
    );
    const live = dbTables.get(tName);
    if (!live) {
      problems.push(`table "${tName}" declared in schema.ts but not migrated`);
      continue;
    }
    for (const col of Object.values(declared)) {
      const dbCol = live.get(col.name);
      if (!dbCol) {
        problems.push(`${tName}.${col.name}: declared but not migrated`);
        continue;
      }
      const dbNullable = dbCol.is_nullable === "YES";
      if (dbNullable === col.notNull) {
        problems.push(
          `${tName}.${col.name}: nullability drift — schema ${col.notNull ? "NOT NULL" : "nullable"}, db is ${dbCol.is_nullable}`,
        );
      }
    }
    for (const name of live.keys()) {
      if (!declaredBySqlName.has(name)) {
        problems.push(`${tName}.${name}: migrated but not declared in schema.ts`);
      }
    }
  }

  for (const tName of dbTables.keys()) {
    if (!seen.has(tName)) {
      problems.push(`table "${tName}" migrated but not declared in schema.ts`);
    }
  }

  if (problems.length) {
    console.error(`schema parity: ${problems.length} drift(s)`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(
    `schema parity ok — ${seen.size} tables, ${rows.length} columns checked`,
  );
} finally {
  await sql.end();
}
