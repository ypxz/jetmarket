#!/usr/bin/env node
// Smoke test against ANY deploy URL — no Playwright needed.
//
//   pnpm smoke --url=https://jetmarket.example.com
//   pnpm smoke                        # http://localhost:3000
//   E2E_BASE_URL=… pnpm smoke
//
// Asserts: GET /api/health → {ok:true}; GET / → rendered HTML, no error page.
import { setTimeout as sleep } from 'node:timers/promises';

function parseUrl() {
  const arg = process.argv.find((a) => a.startsWith('--url'));
  if (arg?.includes('=')) return arg.split('=')[1];
  if (arg) return process.argv[process.argv.indexOf(arg) + 1];
  return (
    process.env.SMOKE_URL ??
    process.env.E2E_BASE_URL ??
    `http://localhost:${process.env.E2E_PORT ?? 3000}`
  );
}

const base = parseUrl().replace(/\/$/, '');
let failures = 0;

async function check(name, path, validate) {
  const url = `${base}${path}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    const problem = validate(res, text);
    if (problem) {
      failures += 1;
      console.log(`FAIL ${name} — ${url} → HTTP ${res.status}: ${problem}`);
    } else {
      console.log(`PASS ${name} — ${url} → HTTP ${res.status}`);
    }
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name} — ${url} → ${err.cause?.code ?? err.message}`);
  }
}

console.log(`smoke → ${base}`);
await check('health endpoint', '/api/health', (res, text) => {
  if (res.status !== 200) return 'expected 200';
  try {
    const body = JSON.parse(text);
    if (body.ok !== true) return `expected {ok:true}, got ${text.slice(0, 120)}`;
  } catch {
    return `non-JSON body: ${text.slice(0, 120)}`;
  }
});
await check('home renders', '/', (res, text) => {
  if (res.status >= 400) return `expected <400`;
  if (!/<html/i.test(text)) return 'no <html> in body';
  if (/internal server error|application error/i.test(text)) return 'error page';
});

// wait for server if it is still booting (dev server cold start)
if (failures > 0) {
  await sleep(2_000);
}
process.exit(failures === 0 ? 0 : 1);
