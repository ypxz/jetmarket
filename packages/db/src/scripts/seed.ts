/**
 * CLI: `pnpm --filter @jetmarket/db seed` — seeds the active vertical
 * (`VERTICAL` env, default jets). Idempotent; seeds coexist in one db.
 */
import { createDb, databaseUrl } from "../client";
import { seedJets } from "../seed/jets";
import { seedMachinery } from "../seed/machinery";

const vertical = process.env.VERTICAL ?? "jets";
const { db, sql } = createDb(databaseUrl());
const res =
  vertical === "machinery" ? await seedMachinery(db) : await seedJets(db);
console.log(
  `seeded ${vertical}: ${res.users} users, ${res.operators} operators, ${res.listings} listings, ${res.photos} photos`,
);
await sql.end();
