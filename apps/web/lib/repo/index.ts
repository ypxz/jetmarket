import type { Repo } from "./types";
import { getMemoryRepo } from "./memory";

// Swap point: when @jetmarket/db lands with a DrizzleRepo implementing Repo,
// select it here via env (DB_PROVIDER=postgres). Until then the slice runs on
// the seeded in-memory repo so the whole flow works with zero infra.
export function getRepo(): Repo {
  return getMemoryRepo();
}
