import type { Sql } from "postgres";
import { envOf } from "../env";
import type { Env } from "../env";
import { todoGoLive } from "../errors";
import { MockSearchProvider } from "./mock";
import { PostgresSearchProvider } from "./postgres";
import { MeilisearchProvider } from "./real";
import type { SearchProvider } from "./types";

export * from "./types";
export { MockSearchProvider } from "./mock";
export { PostgresSearchProvider } from "./postgres";
export { MeilisearchProvider } from "./real";

export type SearchProviderName = "postgres" | "mock" | "meilisearch";

export function searchProviderName(env?: Env): SearchProviderName {
  const e = envOf(env);
  const v = (e.SEARCH_PROVIDER ?? "postgres").toLowerCase();
  return v === "mock" || v === "meilisearch" ? v : "postgres";
}

/**
 * SEARCH_PROVIDER: postgres (default, wraps the db sql client) | mock
 * (in-memory) | meilisearch (skeleton). Postgres needs the `sql` dep.
 */
export function createSearchProvider(env?: Env, deps?: { sql?: Sql }): SearchProvider {
  const e = envOf(env);
  switch (searchProviderName(e)) {
    case "meilisearch":
      return new MeilisearchProvider({
        url: e.MEILISEARCH_URL ?? "http://localhost:7700",
        apiKey: e.MEILISEARCH_KEY,
      });
    case "mock":
      return new MockSearchProvider();
    case "postgres":
    default: {
      if (!deps?.sql) {
        throw todoGoLive(
          "search/postgres",
          "createSearchProvider requires deps.sql (createDb().sql from @jetmarket/db)",
          "packages/db/src/client.ts",
        );
      }
      return new PostgresSearchProvider(deps.sql, ["type", "aircraftCategory"]);
    }
  }
}

// Singleton survives dev-server HMR via globalThis; sql binds on first call.
const g = globalThis as unknown as { __jmSearch?: SearchProvider };
export function searchProvider(env?: Env, deps?: { sql?: Sql }): SearchProvider {
  if (!g.__jmSearch) g.__jmSearch = createSearchProvider(env, deps);
  return g.__jmSearch;
}
