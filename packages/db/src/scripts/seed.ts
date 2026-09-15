/** CLI: `pnpm --filter @jetmarket/db seed` — runs the jets seed (idempotent). */
import { createDb, databaseUrl } from "../client";
import { seedJets } from "../seed/jets";

const { db, sql } = createDb(databaseUrl());
const res = await seedJets(db);
console.log(
  `seeded: ${res.users} users, ${res.operators} operators, ${res.listings} listings, ${res.photos} photos`,
);
await sql.end();
