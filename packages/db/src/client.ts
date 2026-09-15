/**
 * Typed Drizzle client over the `postgres` (postgres.js) driver.
 * `createDb()` reads DATABASE_URL with the compose default for mock mode.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export const DEFAULT_DATABASE_URL =
  "postgres://jetmarket:jetmarket@localhost:5432/jetmarket";

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

export function createDb(url: string = databaseUrl()) {
  const sql = postgres(url, {
    max: 10,
    // Suppress NOTICE noise (e.g. "table exists") during migrate/seed runs.
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export type DbClient = ReturnType<typeof createDb>;
export type Db = DbClient["db"];
export type Sql = DbClient["sql"];
export { schema };
