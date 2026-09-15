/** CLI: `pnpm --filter @jetmarket/db migrate` — applies migrations/*.sql. */
import { createDb, databaseUrl } from "../client";
import { runMigrations } from "../migrate";

const { sql } = createDb(databaseUrl());
const res = await runMigrations(sql);
for (const f of res.applied) console.log(`applied  ${f}`);
for (const f of res.skipped) console.log(`skipped  ${f} (already applied)`);
await sql.end();
