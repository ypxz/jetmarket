import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Integration suite — DB/API tests land in test/integration (T4/T8) or as
 * colocated `*.integration.test.ts` next to the code under test; they may use
 * DATABASE_URL once the Drizzle repo lands (the in-memory repo needs none). */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: [
      "test/integration/**/*.test.ts",
      "app/**/*.integration.test.ts?(x)",
      "lib/**/*.integration.test.ts?(x)",
    ],
    environment: "node",
    passWithNoTests: true,
    testTimeout: 20_000,
  },
});
