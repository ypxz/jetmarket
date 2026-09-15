import { defineConfig } from 'vitest/config';

// Contract tests for provider adapters (stripe-mock, Mailpit). Run with
// `pnpm test:contract`. Specs skip themselves when a service is unreachable —
// bring the stack up with `pnpm db:up` for full coverage.
export default defineConfig({
  test: {
    include: ['contract/**/*.test.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
    passWithNoTests: true,
    testTimeout: 15_000,
  },
});
