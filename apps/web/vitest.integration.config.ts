import { defineConfig } from "vitest/config";

// Integration tests: *.integration.test.ts files, run against real services
// (Postgres via DATABASE_URL). Referenced by `pnpm test:integration`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.integration.test.ts", "test/integration/**/*.test.ts"],
  },
});
