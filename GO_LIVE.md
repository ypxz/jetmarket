# GO_LIVE — human steps to take JetMarket live

> Stub — completed during the hardening cycle (H+6:30). Format per PLAN.md §5/§8:
> which accounts to create, which env vars to fill, expected monthly cost.

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

## Env vars

Every var is documented in `.env.example`. Flip `*_PROVIDER` from `mock` to the
real adapter and fill the keys listed there. Typed `real.ts` skeletons marked
`TODO(go-live)` are listed in RESEARCH/TASKS and must be finished against the
provider's docs/sandbox before real traffic.

## Compliance checklist

- Marketplace-not-broker copy on every page footer + ToS (already scaffolded).
- Operator verification is manual; never display unverified operators as vetted.
- Success-fee invoices are issued to operators only after a deal is marked won.
- No scraped competitor pricing anywhere in seed/copy.
