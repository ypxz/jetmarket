/** CLI: `pnpm --filter @jetmarket/db migrate` — applies migrations/*.sql. */
import { createDb, databaseUrl } from "../client";
import { runMigrations } from "../migrate";

const { sql } = createDb(databaseUrl());
try {
  const res = await runMigrations(sql);
  for (const f of res.applied) console.log(`applied  ${f}`);
  for (const f of res.skipped) console.log(`skipped  ${f} (already applied)`);
} finally {
  await sql.end();
}
