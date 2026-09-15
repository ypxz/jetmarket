import { defineConfig } from "vitest/config";

/**
 * Integration tests run against the compose Postgres (`pnpm db:up`).
 * DATABASE_URL is required; the suite migrates + seeds a clean schema.
 */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
