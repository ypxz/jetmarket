import type { Repo } from "./types";
import { getMemoryRepo } from "./memory";
import { getDrizzleRepo } from "./drizzle";

/**
 * Repo selection: REPO=postgres (or DATABASE_URL set) -> Drizzle over
 * compose Postgres; otherwise the seeded in-memory repo (zero-infra default
 * for unit tests and offline dev). Swap point documented in TASKS.md.
 */
export async function getRepo(): Promise<Repo> {
  const backend = process.env.REPO ?? (process.env.DATABASE_URL ? "postgres" : "memory");
  if (backend === "postgres") return getDrizzleRepo();
  return getMemoryRepo();
}
