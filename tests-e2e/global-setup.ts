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

// The e2e web server gets DATABASE_URL=testDatabaseUrl — seeds, RFQs and jobs
// land there. Refuse a non-`*_test` name so e2e can never run against the dev
// database (QA-139: TEST_DATABASE_URL=…/jetmarket once polluted dev data).
if (
  process.env.ALLOW_DESTRUCTIVE_TEST_DB !== '1' &&
  !testDbName.endsWith('_test')
) {
  throw new Error(
    `[e2e setup] refusing to run e2e against database "${testDbName}" ` +
      '(expected a *_test database; set ALLOW_DESTRUCTIVE_TEST_DB=1 to override)',
  );
}

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
  // Reused-server guard (QA-289): webServer.reuseExistingServer happily
  // reuses ANYTHING on the port — a stale `pnpm dev` in memory mode swaps
  // the suite's whole backend (seeded uid() fixtures don't exist there,
  // every seed-dependent spec fails). Probe /api/health's backend field
  // and refuse loudly instead of running 40 bogus tests.
  const base = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? 3100}`;
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
    const health = (await res.json()) as { backend?: string; vertical?: string };
    const wantVertical = process.env.VERTICAL ?? 'jets';
    if (
      (health.backend && health.backend !== 'postgres') ||
      (health.vertical && health.vertical !== wantVertical)
    ) {
      throw new Error(
        `[e2e setup] ${base} already serves backend="${health.backend}" vertical="${health.vertical}" — ` +
          `e2e needs the postgres-backed "${wantVertical}" server it spawns itself. ` +
          `Kill the stale process (e.g. \`pkill -f "next dev -p ${process.env.E2E_PORT ?? 3100}"\`) and re-run.`,
      );
    }
  } catch (err) {
    // No server yet — webServer will spawn one; only backend mismatches abort.
    if (err instanceof Error && err.message.includes('already serves')) throw err;
  }

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

  // Reset before seeding: suites sharing *_test DBs leave rows behind (and a
  // stray worker/integration run can deliver seeded delayed matches — QA-266).
  // Without a clean schema, leftover RFQs/matches make inbox assertions flaky.
  const resetSql = postgres(testDatabaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await resetSql`drop schema public cascade`;
    await resetSql`create schema public`;
    console.log(`[e2e setup] reset schema on ${testDbName}`);
  } catch (err) {
    console.warn(`[e2e setup] schema reset failed on ${testDbName}: ${String(err)}`);
  } finally {
    await resetSql.end();
  }

  for (const script of ['migrate', 'seed']) {
    try {
      runDbScript(script);
    } catch {
      console.warn(`[e2e setup] @jetmarket/db ${script} not available yet — skipped`);
    }
  }
}
