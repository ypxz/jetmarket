import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const port = Number(process.env.E2E_PORT ?? 3000);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;

// Database used by the e2e web server. Isolated from the dev database so e2e
// runs never touch developer data; created/migrated by global-setup.ts.
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://jetmarket:jetmarket@localhost:5432/jetmarket';
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  databaseUrl.replace(/\/[^/?]+(\?.*)?$/, '/jetmarket_test');

function hasSpecs(dir: string) {
  const abs = path.join(__dirname, dir);
  return (
    fs.existsSync(abs) &&
    fs.readdirSync(abs).some((f) => f.endsWith('.spec.ts') || f.endsWith('.spec.tsx'))
  );
}

// Boot `pnpm dev` only when there is something to run against it: enabled specs
// in e2e/, or an explicit opt-in (test:pending sets E2E_SERVER=1 so pending/
// specs get a server before they are promoted). With no matching specs the
// config has no webServer/globalSetup and `playwright test` exits green.
const wantServer =
  !process.env.E2E_BASE_URL && (hasSpecs('e2e') || process.env.E2E_SERVER === '1');

export default defineConfig({
  testDir: __dirname,
  outputDir: path.join(__dirname, 'test-results'),
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testMatch: 'e2e/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Specs written ahead of the app (see TESTIDS.md). Promote by moving the
      // file to e2e/ once the testids it uses exist; CI runs e2e/ only.
      name: 'pending',
      testMatch: 'pending/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  ...(wantServer
    ? {
        globalSetup: path.join(__dirname, 'global-setup.ts'),
        webServer: {
          command: `pnpm --dir ${repoRoot} dev -p ${port}`,
          // Probe /api/health, not /: the landing page queries the DB, which
          // global-setup may still be provisioning (jetmarket_test) when the
          // dev server first accepts connections — a 500 there timed out CI.
          url: `${baseURL}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          stdout: 'pipe' as const,
          stderr: 'pipe' as const,
          env: {
            ...process.env,
            PORT: String(port),
            DATABASE_URL: testDatabaseUrl,
            VERTICAL: process.env.VERTICAL ?? 'jets',
            APP_URL: baseURL,
            AUTH_PROVIDER: process.env.AUTH_PROVIDER ?? 'mock',
            EMAIL_PROVIDER: process.env.EMAIL_PROVIDER ?? 'mock',
            PAYMENTS_PROVIDER: process.env.PAYMENTS_PROVIDER ?? 'mock',
            STORAGE_PROVIDER: process.env.STORAGE_PROVIDER ?? 'mock',
            CAPTCHA_PROVIDER: process.env.CAPTCHA_PROVIDER ?? 'mock',
            SEARCH_PROVIDER: process.env.SEARCH_PROVIDER ?? 'postgres',
            ANALYTICS_PROVIDER: process.env.ANALYTICS_PROVIDER ?? 'mock',
            SESSION_SECRET: process.env.SESSION_SECRET ?? 'e2e-only-not-a-secret',
          },
        },
      }
    : {}),
});
