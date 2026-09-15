// Shared Vitest base config for all @jetmarket/* packages.
// Usage in a package's vitest.config.ts:
//
//   import { packageVitestConfig } from '../../vitest.shared';
//   export default packageVitestConfig();
//
// Integration tests that need Postgres should live in *.integration.test.ts and
// read DATABASE_URL from the env (contract tests that need stripe-mock/Mailpit
// belong in tests-e2e/contract so the service probes stay in one place).
import { defineConfig, mergeConfig, type UserConfig } from 'vitest/config';

export const baseTestConfig: UserConfig = {
  test: {
    environment: 'node',
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/e2e/**',
      '**/pending/**',
      '**/contract/**',
    ],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Per-plan requirement: >=80% coverage of packages/domain (TASKS.md T2).
      // Applies only when coverage is collected (e.g. `vitest run --coverage`).
      thresholds: {
        'packages/domain/**': {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },
      },
    },
  },
};

export function packageVitestConfig(overrides: UserConfig = {}) {
  return mergeConfig(defineConfig(baseTestConfig), defineConfig(overrides));
}
