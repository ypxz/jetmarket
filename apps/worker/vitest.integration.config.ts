import { defineConfig } from "vitest/config";

/** Integration tests vs compose postgres (`pnpm db:up`, DATABASE_URL). */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
