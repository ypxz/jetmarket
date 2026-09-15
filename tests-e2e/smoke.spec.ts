import { test, expect } from "@playwright/test";

// Placeholder — verifies the Playwright harness loads in CI.
// TODO(T8): replace with the real core-loop spec
// (operator → listing → RFQ → quote → deal → admin ledger → Pro upgrade).
test("e2e harness loads", { tag: "@smoke" }, async () => {
  expect(true).toBe(true);
});
