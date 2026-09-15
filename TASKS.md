# TASKS — JetMarket live board

Lead: Devin session (jetmarket lead). Workers update their ticket's status in
their PR. Severities for dogfood findings: **blocker > bug > polish > idea**.

Legend: `[]` open · `[~]` in progress (owner) · `[x]` merged · `[!]` blocked (note why)

## Wave 1 — foundation + vertical slice (target: slice green by H+2:30 = 00:00 UTC)

| # | Status | Ticket | Owns (files/dirs — touch nothing else) | Acceptance |
|---|--------|--------|-----------------------------------------|------------|
| T1 | [x] W1 | Research (RESEARCH.md) | `RESEARCH.md`, feeds `marketing/` | Checklist in RESEARCH.md complete; licenses verified |
| T2 | [~] W2 | Domain core: types, matching, fees, plan limits | `packages/domain/**` | `pnpm --filter @jetmarket/domain test` green; ≥80% cov of domain |
| T3 | [~] W3 | Verticals: contract + `jets` config + `machinery` scaffold | `packages/verticals/**` | `VerticalConfig` type; zod schemas; config loads by `VERTICAL` env; unit-tested |
| T4 | [~] W2 | DB: Drizzle schema + migrations + typed client + jets seed | `packages/db/**` | `db:migrate`+`db:seed` run on compose pg; integration test green |
| T5 | [~] W2 | Providers: auth, email, storage, payments, captcha, search, analytics | `packages/providers/**` | each `mock` deterministic; `real` = typed skeleton or stripe vs stripe-mock; contract tests where possible |
| T6 | [~] W3 | Web slice: browse/search+facets, listing page, RFQ form | `apps/web/**` (public routes) + `packages/ui/**`, `packages/i18n/**`, `packages/config/**` | buyer: search → listing → RFQ saved; mock email quote page; responsive |
| T7 | [] | Operator + admin slice: auth, operator profile, listings CRUD, RFQ inbox, quote, won/lost, admin verify + fee ledger | `apps/web/**` (`/app`, `/admin`, `/api`) | operator→listing→RFQ→quote→accept path works end-to-end in mock mode |
| T8 | [~] W4 | Tests/CI wiring: vitest setup, playwright config, e2e core-loop spec, smoke test | `tests-e2e/**`, root configs, `.github/workflows/ci.yml` | `pnpm test:all` green locally + CI green on main |
| T9 | [] | Billing: plans, mock checkout, webhook→subscriptions, plan-limit middleware, upgrade e2e | `apps/web/app/(billing)`, `packages/domain/plans.ts`, providers payments | free=3 listings enforced server-side; mock checkout upgrades to Pro |
| T10 | [] | Landing + marketing pages on design system; legal pages | `apps/web/app/(marketing)`, `packages/ui/blocks`, `content/*.ts`, `messages/en.json` | hero/pricing/FAQ/footer/legal render from config; `/design` gallery |

## Wave 2 — depth (start after slice, parallel where possible)

| # | Status | Ticket | Owns | Acceptance |
|---|--------|--------|------|------------|
| T11 | [] | Seed data: 15 operators, 60 listings incl. empty legs ZRH/GVA/NCE/LTN; realistic synthetic | `packages/db/seed/**` | `db:seed` idempotent; photos via storage mock |
| T12 | [] | SEO route pages from `vertical.seo.landingPages` (e.g. "empty legs Zurich–Nice") | `apps/web/app/(seo)`, `packages/verticals/*/seo.ts` | ≥10 route pages per vertical, sitemap.xml |
| T13 | [] | RFQ fan-out matching: RFQ → N operators by fleet fit + notify via email adapter | `packages/domain/matching*`, `apps/worker/**` | unverified operators get delay; unit-tested |
| T14 | [] | Success-fee invoices: deal→invoice record→payments adapter (mock + stripe-mock) | `packages/domain/fees*`, `apps/web/app/api/invoices`, admin ledger UI | 3% charter/1.5% sale; invoice appears in admin |
| T15 | [] | Rate limit + honeypot + captcha adapter on RFQ/public forms | `apps/web`, `packages/providers/captcha` | >RFQ_RATE_LIMIT/hour → 429; e2e covers |
| T16 | [] | Machinery vertical proof: `VERTICAL=machinery` boots, placeholder taxonomy, same flow e2e | `packages/verticals/machinery`, e2e spec | second acceptance e2e passes |
| T17 | [] | i18n/completeness + currency formatting; a11y pass; empty/loading/error states | `apps/web`, `packages/i18n` | grep: no string literals in apps; a11y e2e on core loop |
| T18 | [] | Ops: health endpoint, structured logging, Dockerfile web+worker, deploy notes | `apps/*`, `Dockerfile*`, `docs/deploy.md` | `docker build` green; `/api/health` 200 |
| T19 | [x] W1 | Marketing kit: positioning vs Avinode/XO/Stratajet, operator outreach email, 10 SEO titles, LinkedIn post, first-20-operators list | `marketing/**` | per spec §"Marketing kit" |
| T20 | [~] W4 (from H+2:30) | QA/dogfood loop worker (from H+2:30): fresh-user runs, files findings here, verifies fixes | reports only; files tickets | ≥1 cycle/90 min; cycle count + bugs logged to STATUS |

## Improvement-loop log (append per cycle)

| Cycle | Time | Findings filed | Fixed | Notes |
|---|---|---|---|---|

## Decisions we made for the human (mirrored to MORNING_REPORT)

- Drizzle + plain Postgres chosen over local Supabase stack (lighter, fully
  offline; Supabase remains the `real` auth/storage skeleton and GO_LIVE path).
- Marketplace backend written, not forked: medusa too heavy, sharetribe license
  incompatible — details in RESEARCH.md.
- `aircraft_sale` kept in scope for night 1; spec fallback was to drop it.
- LLM adapter skipped (spec doesn't need it); stub noted in `.env.example`.
- DB driver: `postgres` (postgres.js, Unlicense) — flagged in THIRD_PARTY.md;
  swap to MIT `pg` is a one-line change if policy tightens.
