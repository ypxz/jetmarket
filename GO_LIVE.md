# GO_LIVE — human steps to take JetMarket live

> Format per PLAN.md §5/§8: which accounts to create, which env vars to fill,
> expected monthly cost. Mock mode is the default everywhere — the product
> demos fully offline today (`pnpm i && pnpm dev`).

## What is verified vs what is a skeleton

| Path | Status |
|---|---|
| Core loop (operator → listing → RFQ → quote → accept → deal + fee invoice → Pro upgrade) | **verified e2e** — Playwright, memory + Postgres |
| `VERTICAL=machinery` same loop | **verified e2e** (second CI e2e leg) |
| RFQ fan-out matching + delayed notify for unverified operators | **verified on Postgres + worker** |
| Stripe payments (checkout/webhook/invoices) | **contract-tested vs stripe-mock**; live keys untested |
| Email delivery | mock outbox + Mailpit contract; `resend`/`smtp` skeletons `TODO(go-live)` |
| Supabase auth/storage | skeletons `TODO(go-live)`; mock auth + local storage verified |
| Turnstile captcha | skeleton + mock `force-fail` path tested; real site key untested |

## Deploy path (cheapest first)

1. `docker build -f Dockerfile.web -t jetmarket-web .` and
   `docker build -f Dockerfile.worker -t jetmarket-worker .` (or Fly.io
   `fly launch` per service). Verified: web image boots + serves `/en` + `/api/health`.
2. Point `DATABASE_URL`/`TEST_DATABASE_URL` at managed Postgres; run
   `pnpm --filter @jetmarket/db migrate` + `seed` once.
3. `VERTICAL=jets` (or your config folder), `APP_URL` to the public origin,
   `SESSION_SECRET` to a real random value, `ADMIN_EMAILS` to yours.
4. `WORKER_POLL_MS` optional; the worker only needs `DATABASE_URL` — no web env.

## Accounts to create (human-only — phone/card/identity required)

| Service | Why | Signup | Est. monthly cost (launch) |
|---|---|---|---|
| Vercel (or Fly.io) | host apps/web + worker | vercel.com | $0–20 |
| Supabase / Neon | Postgres + optional Supabase Auth + Storage | supabase.com | $0–25 |
| Stripe | subscriptions + success-fee invoices | stripe.com (needs KYC) | $0 + % fees |
| Resend (or SES) | transactional email (quotes, RFQs) | resend.com | $0–20 |
| Cloudflare Turnstile | RFQ spam guard | cloudflare.com | $0 |
| (optional) Meilisearch Cloud | if Postgres FTS is outgrown | meilisearch.com | $0–30 |
| (optional) S3/R2 | listing photos at scale | aws / cloudflare | $0–10 |

### Key obtainability (research, T1 — full matrix in RESEARCH.md §3)

- **Email-only signups an agent could self-obtain** (PLAN.md §5 allows): Supabase
  hosted, Resend, Cloudflare Turnstile, Meilisearch Cloud, Vercel hobby — all
  free tiers, no card/phone. Use only with session env, never commit.
- **Human-only** (card/KYC/phone): Stripe live, AWS S3/R2, OpenAI, production
  Vercel/org decisions.
- **Official local mocks already wired**: stripe-mock, Mailpit, Postgres via
  `pnpm db:up`; `supabase start` remains the local-auth option.

## Env vars

Every var is documented in `.env.example` (audit: 100% coverage of
`process.env.*` usage). Flip `*_PROVIDER` from `mock` to the real adapter and
fill the keys listed there. Typed `real.ts` skeletons marked `TODO(go-live)`
are listed in RESEARCH/TASKS and must be finished against the provider's
docs/sandbox before real traffic.

## Compliance checklist

- Marketplace-not-broker copy on every page footer + ToS (already scaffolded).
- Operator verification is manual; never display unverified operators as vetted.
- Success-fee invoices are issued to operators only after a deal is marked won.
- No scraped competitor pricing anywhere in seed/copy.
