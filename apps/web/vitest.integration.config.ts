import { defineConfig } from "vitest/config";

// Integration tests (API routes + repo/DB). Referenced by `pnpm test:integration`.
// Convention: colocate `*.integration.test.ts` files next to the code under
// test; they may use DATABASE_URL when the Drizzle repo lands (the in-memory
// repo needs no infra).
export default defineConfig({
  test: {
    include: ["app/**/*.integration.test.ts?(x)", "lib/**/*.integration.test.ts?(x)"],
    environment: "node",
    passWithNoTests: true,
    testTimeout: 20_000,
  },
});
