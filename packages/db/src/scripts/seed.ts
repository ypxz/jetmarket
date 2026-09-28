/**
 * CLI: `pnpm --filter @jetmarket/db seed` — seeds the active vertical
 * (`VERTICAL` env, default jets). Idempotent; seeds coexist in one db.
 */
import { createDb, databaseUrl } from "../client";
import { seedJets } from "../seed/jets";
import { seedMachinery } from "../seed/machinery";

const vertical = process.env.VERTICAL ?? "jets";
const { db, sql } = createDb(databaseUrl());
try {
  const res =
    vertical === "machinery" ? await seedMachinery(db) : await seedJets(db);
  console.log(
    `seeded ${vertical}: ${res.users} users, ${res.operators} operators, ${res.listings} listings, ${res.photos} photos, ${res.rfqs} rfqs`,
  );
} finally {
  // A throw mid-seed must not leave the pool open — the CLI would hang
  // forever instead of exiting non-zero.
  await sql.end();
}
