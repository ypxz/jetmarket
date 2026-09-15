import { defineConfig } from "vitest/config";

/**
 * Contract tests against compose services (`pnpm db:up`):
 * stripe-mock on STRIPE_API_BASE, Mailpit on SMTP_URL, Postgres via DATABASE_URL.
 * Each suite skips itself when its endpoint is unreachable.
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
