# TASKS — JetMarket live board

Lead: Devin session (jetmarket lead). Workers update their ticket's status in
their PR. Severities for dogfood findings: **blocker > bug > polish > idea**.

Legend: `[]` open · `[~]` in progress (owner) · `[x]` merged · `[!]` blocked (note why)

## Wave 1 — foundation + vertical slice (target: slice green by H+2:30 = 00:00 UTC)

| # | Status | Ticket | Owns (files/dirs — touch nothing else) | Acceptance |
|---|--------|--------|-----------------------------------------|------------|
| T1 | [x] W1 | Research (RESEARCH.md) | `RESEARCH.md`, feeds `marketing/` | Checklist in RESEARCH.md complete; licenses verified |
| T2 | [x] W2 | Domain core: types, matching, fees, plan limits | `packages/domain/**` | `pnpm --filter @jetmarket/domain test` green; ≥80% cov of domain |
| T3 | [x] W3 | Verticals: contract + `jets` config + `machinery` scaffold | `packages/verticals/**` | `VerticalConfig` type; zod schemas; config loads by `VERTICAL` env; unit-tested |
| T4 | [x] W2 | DB: Drizzle schema + migrations + typed client + jets seed | `packages/db/**` | `db:migrate`+`db:seed` run on compose pg; integration test green |
| T5 | [x] W2 | Providers: auth, email, storage, payments, captcha, search, analytics | `packages/providers/**` | each `mock` deterministic; `real` = typed skeleton or stripe vs stripe-mock; contract tests where possible |
| T6 | [x] W3 | Web slice: browse/search+facets, listing page, RFQ form | `apps/web/**` (public routes) + `packages/ui/**`, `packages/i18n/**`, `packages/config/**` | buyer: search → listing → RFQ saved; mock email quote page; responsive |
| T7 | [x] lead | Operator + admin slice: auth, operator profile, listings CRUD, RFQ inbox, quote, won/lost, admin verify + fee ledger | `apps/web/**` (`/app`, `/admin`, `/api`) | operator→listing→RFQ→quote→accept path works end-to-end in mock mode |
| T8 | [x] W4 | Tests/CI wiring: vitest setup, playwright config, e2e core-loop spec, smoke test | `tests-e2e/**`, root configs, `.github/workflows/ci.yml` | `pnpm test:all` green locally + CI green on main |
| T9 | [x] lead | Billing: plans, mock checkout, webhook→subscriptions, plan-limit middleware, upgrade e2e | `apps/web/app/(billing)`, `packages/domain/plans.ts`, providers payments | free=3 listings enforced server-side; mock checkout upgrades to Pro |
| T10 | [x] W3 | Landing + marketing pages on design system; legal pages | `apps/web/app/(marketing)`, `packages/ui/blocks`, `content/*.ts`, `messages/en.json` | hero/pricing/FAQ/footer/legal render from config; `/design` gallery |

## Wave 2 — depth (start after slice, parallel where possible)

| # | Status | Ticket | Owns | Acceptance |
|---|--------|--------|------|------------|
| T11 | [] | Seed data: 15 operators, 60 listings incl. empty legs ZRH/GVA/NCE/LTN; realistic synthetic | `packages/db/seed/**` | `db:seed` idempotent; photos via storage mock |
| T12 | [x] W3 | SEO route pages from `vertical.seo.landingPages` (e.g. "empty legs Zurich–Nice") | `apps/web/app/(seo)`, `packages/verticals/*/seo.ts` | ≥10 route pages per vertical, sitemap.xml |
| T13 | [] | RFQ fan-out matching: RFQ → N operators by fleet fit + notify via email adapter | `packages/domain/matching*`, `apps/worker/**` | unverified operators get delay; unit-tested |
| T14 | [] | Success-fee invoices: deal→invoice record→payments adapter (mock + stripe-mock) | `packages/domain/fees*`, `apps/web/app/api/invoices`, admin ledger UI | 3% charter/1.5% sale; invoice appears in admin |
| T15 | [] | Rate limit + honeypot + captcha adapter on RFQ/public forms | `apps/web`, `packages/providers/captcha` | >RFQ_RATE_LIMIT/hour → 429; e2e covers |
| T16 | [] | Machinery vertical proof: `VERTICAL=machinery` boots, placeholder taxonomy, same flow e2e | `packages/verticals/machinery`, e2e spec | second acceptance e2e passes |
| T17 | [x] W1 | i18n/completeness + currency formatting; a11y pass; empty/loading/error states | `apps/web`, `packages/i18n` | grep: no string literals in apps; a11y e2e on core loop |
| T18 | [x] W1 | Ops: health endpoint, structured logging, Dockerfile web+worker, deploy notes | `apps/*`, `Dockerfile*`, `docs/deploy.md` | `docker build` green; `/api/health` 200 |
| T19 | [x] W1 | Marketing kit: positioning vs Avinode/XO/Stratajet, operator outreach email, 10 SEO titles, LinkedIn post, first-20-operators list | `marketing/**` | per spec §"Marketing kit" |
| T20 | [~] W4 (from H+2:30) | QA/dogfood loop worker (from H+2:30): fresh-user runs, files findings here, verifies fixes | reports only; files tickets | ≥1 cycle/90 min; cycle count + bugs logged to STATUS |

## QA findings (T20 dogfood)

| # | Severity | Finding | Status | Owns |
|---|----------|---------|--------|------|
| QA-1 | bug | Accepting a quote creates the deal/fee ledger entry but the RFQ stays `quoted` and the operator dashboard still counts it open (repro: $6,000 + $7,000 quotes; accept persists, Accept button correctly disappears) | filed | `apps/web/app/api/quotes/[id]/accept`, repo status transition |
| QA-2 | bug | Negative `seats` accepted on listing publish (−2 → listing goes active) | fixed (PR#14: zod attr validation → 422) | `apps/web` listing form/API validation, `packages/verticals` schema |
| QA-3 | bug | Mobile 390px viewport: operator header overflows — document width 554px; email + nav clip. Empty-leg date/model placeholders clip too | fixed (PR#15) | `apps/web` app shell/header |
| QA-4 | bug | Publish button has no busy state: double-click creates duplicate listings (repro: two identical "Fourth Charter" rows) | fixed (PR#15: pending state) | `apps/web` listing form |
| QA-5 | polish | Listing-type selector shows raw i18n keys (`listingTypes charter`, `listingTypes empty leg`, `listingTypes aircraft sale`) post-template | fixed (PR#14: vertical-namespace labels) | `packages/i18n`/`apps/web` type select |
| QA-6 | polish | Dashboard/billing copy promises delayed RFQs for free/unverified operators, but RFQs arrive immediately | filed | copy vs T13 matching behavior — align |
| QA-7 | polish | No sign-out / account-switch control (must navigate to `/sign-in` manually) | fixed (PR#15) | `apps/web` app shell |
| QA-8 | idea | No dark mode / theme toggle reachable | filed | `packages/ui`, `apps/web` |

## Improvement-loop log (append per cycle)

| Cycle | Time | Findings filed | Fixed | Notes |
|---|---|---|---|---|
| 1 | H+3:00 | QA-1..QA-8 (4 bug, 3 polish, 1 idea) | — | Fresh-user run, mock mode, desktop+mobile(390px). Interrupted mid-run by concurrent merge/next-dev — mobile admin/landing + clean rerun deferred to cycle 2. Screens: docs/screens/cycle1-* |

## Decisions we made for the human (mirrored to MORNING_REPORT)

- Drizzle + plain Postgres chosen over local Supabase stack (lighter, fully
  offline; Supabase remains the `real` auth/storage skeleton and GO_LIVE path).
- Marketplace backend written, not forked: medusa too heavy, sharetribe license
  incompatible — details in RESEARCH.md.
- `aircraft_sale` kept in scope for night 1; spec fallback was to drop it.
- LLM adapter skipped (spec doesn't need it); stub noted in `.env.example`.
- DB driver: `postgres` (postgres.js, Unlicense) — flagged in THIRD_PARTY.md;
  swap to MIT `pg` is a one-line change if policy tightens.
- Repo contract made fully async; `REPO` env selects memory|postgres
  (defaults: DATABASE_URL set -> postgres). DrizzleRepo verified: full
  core-loop e2e green against seeded Postgres (60 listings).
