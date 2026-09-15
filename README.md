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
pnpm db:migrate && pnpm db:seed
pnpm dev          # http://localhost:3000
```

All external services default to `mock` — see `.env.example`.

Tests: `pnpm test:all` (unit → integration → contract → e2e).
Smoke vs any deploy: `pnpm smoke --url=https://…`.

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
