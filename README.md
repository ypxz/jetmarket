# JetMarket

Modular high-ticket marketplace — **jets first**: charter, empty legs and aircraft
for sale from vetted operators. Buyers request once, receive quotes, and JetMarket
takes a success fee only when a deal closes.

Vertical modularity is the point: everything jet-specific lives in
`packages/verticals/jets/` (taxonomy, attributes, facets, RFQ fields, fees, copy,
SEO pages). `machinery` is a second config folder proving the abstraction — switch
with `VERTICAL=machinery`.

## 5-minute run (mock mode, fully offline)

```bash
pnpm i
pnpm db:up        # postgres + stripe-mock + mailpit (docker)
pnpm db:migrate && pnpm db:seed        # seeds active vertical (VERTICAL env, default jets; machinery seeds 8 dealers/17 listings)
pnpm dev          # http://localhost:3000
pnpm --filter @jetmarket/worker dev   # optional: RFQ fan-out + expiry sweep (postgres mode; memory mode fans out inline)
```

All external services default to `mock` — see `.env.example`.

One-command containerized run (web + worker + postgres + mailpit):

```bash
docker compose --profile app up --build   # http://localhost:3000, mail http://localhost:8025
# SEED_DEMO_DATA=1 seeds the demo vertical on first boot (default); VERTICAL=machinery switches.
```

Tests: `pnpm test:all` (unit → integration → contract → e2e).
Smoke vs any deploy: `pnpm smoke --url=https://…`.

**Integration/e2e tests are destructive** (they drop the public schema) — they
run against per-suite `*_test` databases (`jetmarket_test` for web+e2e,
`jetmarket_worker_test`, `jetmarket_providers_test`, `jetmarket_db_test`),
auto-created when missing. Override via `*_TEST_DATABASE_URL` env vars
(`TEST_DATABASE_URL`, `WORKER_TEST_DATABASE_URL`, `DB_TEST_DATABASE_URL`,
`PROVIDERS_TEST_DATABASE_URL`); anything not ending in `_test` is refused
(`ALLOW_DESTRUCTIVE_TEST_DB=1` overrides).

## Layout

```
apps/web            Next.js 15 App Router — marketplace UI + API routes
apps/worker         background jobs (RFQ fan-out, quote notifications, fee ledger)
packages/domain     pure TS business logic — matching, fees, plan limits (no I/O)
packages/verticals  <slug>/ config: schema, facets, RFQ fields, fees, copy, SEO
packages/db         Drizzle schema, migrations, typed client, seed
packages/providers  <service>/{types,mock,real,index}.ts — env-selected adapters
packages/ui         tokens + primitives + blocks (from shared template)
packages/i18n       next-intl config + messages/en.json
packages/config     plans, site content
tests-e2e           Playwright core loop + smoke
```

## Docs

`TASKS.md` (live tickets) · `RESEARCH.md` · `GO_LIVE.md` (human go-live steps) ·
`THIRD_PARTY.md` (reused OSS + licenses) · `marketing/` · `docs/screens/`

Legal note: JetMarket is a marketplace, not a broker or operator. Contracts are
between buyer and operator. Regulatory claims (Part 135 / AOC) are
operator-declared fields only.
