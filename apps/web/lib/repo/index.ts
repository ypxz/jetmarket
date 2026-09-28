import type { Repo } from "./types";
import { getMemoryRepo } from "./memory";
import { getDrizzleRepo } from "./drizzle";

/**
 * Repo selection: REPO=postgres (or DATABASE_URL set) -> Drizzle over
 * compose Postgres; otherwise the seeded in-memory repo (zero-infra default
 * for unit tests and offline dev). Swap point documented in TASKS.md.
 */
export function repoBackend(): string {
  return (
    process.env.REPO ?? (process.env.DATABASE_URL ? "postgres" : "memory")
  );
}

export async function getRepo(): Promise<Repo> {
  const backend = repoBackend();
  if (backend === "postgres") return getDrizzleRepo();
  if (backend === "memory") return getMemoryRepo();
  // A typo'd REPO value must fail loudly — silently booting the in-memory
  // repo in prod would drop every row at restart.
  throw new Error(`unknown REPO backend: ${backend}`);
}
