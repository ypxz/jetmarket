// Playwright global setup — runs before the web server boots.
// The slice currently runs on the in-memory repo (no DB needed); once
// @jetmarket/db ships a `migrate` script, this provisions an isolated
// jetmarket_test database and runs migrate + seed against it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const adminUrl =
  process.env.DATABASE_URL ??
  'postgres://jetmarket:jetmarket@localhost:5432/jetmarket';
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  adminUrl.replace(/\/[^/?]+(\?.*)?$/, '/jetmarket_test');
const testDbName = new URL(testDatabaseUrl).pathname.replace(/^\//, '');

function dbPkgHasScript(script: string) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'packages/db/package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    return Boolean(pkg.scripts?.[script]);
  } catch {
    return false;
  }
}

function runDbScript(script: string) {
  execFileSync('pnpm', ['--filter', '@jetmarket/db', 'run', script], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}

export default async function globalSetup() {
  if (!dbPkgHasScript('migrate') && !process.env.E2E_REQUIRE_DB) {
    console.log('[e2e setup] no @jetmarket/db migrate script — skipping test DB provisioning');
    return;
  }

  const sql = postgres(adminUrl, { max: 1, connect_timeout: 10 });
  try {
    const existing =
      await sql`select 1 from pg_database where datname = ${testDbName}`;
    if (existing.length === 0) {
      await sql.unsafe(`create database "${testDbName}"`);
      console.log(`[e2e setup] created database ${testDbName}`);
    }
  } catch (err) {
    console.warn(
      `[e2e setup] could not ensure database ${testDbName}: ${String(err)}\n` +
        '  Is Postgres running? (`pnpm db:up`)',
    );
    return; // let webServer/tests surface the failure with better context
  } finally {
    await sql.end();
  }

  for (const script of ['migrate', 'seed']) {
    try {
      runDbScript(script);
    } catch {
      console.warn(`[e2e setup] @jetmarket/db ${script} not available yet — skipped`);
    }
  }
}
