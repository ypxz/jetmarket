import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Integration suite — DB/API tests land in test/integration (T4/T8). */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
  },
});
