import { defineConfig } from "@playwright/test";

// E2E harness for JetMarket. E2E_BASE_URL points at a deployed app for `pnpm smoke`;
// local runs expect `pnpm dev` on :3000 (T8 will wire webServer startup).
export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
});
