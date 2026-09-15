#!/usr/bin/env node
// `pnpm test:all` — the full local pyramid, runnable from a fresh clone:
//   services (compose) → migrate → seed → lint → typecheck → unit →
//   integration → contract → e2e
//
// Service steps tolerate missing pieces (docker absent, db scripts not yet
// landed) so the script stays green while packages are still scaffolded;
// contract specs skip individually when a service is unreachable.
// `--no-docker` skips the compose step entirely.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noDocker = process.argv.includes('--no-docker');
let failed = null;

function step(name, cmd, args, { optional = false, cwd = root } = {}) {
  if (failed) return;
  console.log(`\n══ ${name} ══`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd, env: process.env });
  if (res.status !== 0) {
    if (optional) {
      console.log(`── skipped/failed (optional): ${name}`);
    } else {
      failed = name;
      console.error(`── FAILED: ${name}`);
    }
  }
}

function pkgHasScript(pkgDir, script) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, pkgDir, 'package.json'), 'utf8'));
    return Boolean(pkg.scripts?.[script]);
  } catch {
    return false;
  }
}

if (!noDocker) {
  step('docker compose services', 'docker', [
    'compose', 'up', '-d', '--wait', 'postgres', 'stripe-mock', 'mailpit',
  ], { optional: true });
}

for (const s of ['migrate', 'seed']) {
  if (pkgHasScript('packages/db', s)) {
    step(`db:${s}`, 'pnpm', ['-r', '--if-present', s], { optional: true });
  }
}

step('lint (incl. design-literal check)', 'pnpm', ['lint']);
step('typecheck', 'pnpm', ['typecheck']);
step('unit tests', 'pnpm', ['test']);
step('integration tests', 'pnpm', ['test:integration']);
step('contract tests', 'pnpm', ['test:contract']);
step('e2e tests', 'pnpm', ['test:e2e']);

if (failed) {
  console.error(`\ntest:all FAILED at "${failed}"`);
  process.exit(1);
}
console.log('\ntest:all green');
