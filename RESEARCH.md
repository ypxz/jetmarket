# RESEARCH — JetMarket (PLAN.md §4)

> Status: **in progress** — owned by the research worker (ticket T1). This stub
> records the standing decisions so implementation can start; the worker fills in
> the full tables and merges via PR.

## Standing decisions (lead, H+0)

| Subsystem | Decision | Why |
|---|---|---|
| Framework/monorepo | pnpm workspace + Next.js 15 App Router | prescribed by template spec |
| DB | Postgres 16 (docker-compose) + Drizzle ORM | spec allows Drizzle; lighter than local Supabase stack, fully offline |
| Auth | `auth` provider adapter: mock magic-link now, Supabase skeleton for go-live | no keys tonight |
| Payments | `payments` adapter: mock + stripe vs stripe-mock | PLAN.md §5 |
| Email | `email` adapter: mock outbox + SMTP (Mailpit) + resend skeleton | |
| Storage | `storage` adapter: local FS mock + s3/supabase skeleton | |
| Search | Postgres full-text + jsonb facets; meilisearch adapter optional skeleton | spec |
| Captcha/rate-limit | `captcha` adapter mock + turnstile skeleton; DB/token-bucket rate limit | spec guardrails |
| Marketplace backend | write, not fork | medusa too heavy; sharetribe license-incompatible; our data model is small |
| Design system | adopt `buildApps/template` tokens/primitives when it lands | template ETA ≤90 min |

## Research worker checklist (T1)

1. OSS shortlist ≤5: Next.js marketplace/SaaS starters (name, stars, last commit,
   license, fit ≥50%?): `nextjs/saas-starter`, `ixartz/SaaS-Boilerplate`,
   `shadcn-ui/taxonomy`, `vercel/commerce`, `medusajs/medusa`, `sharetribe`.
2. Competitors 3–5 with public pricing: Avinode, XO/JetSmarter successor, Stratajet
   successors, Controller/Trade-A-Plane, CharterPad, Jet Partners, Lunajets.
   → confirms willingness to pay + sets our price ($199/mo Pro, 3%/1.5% fee).
3. API/ToS check: which providers are mock-only tonight vs free-key vs human-only
   (→ `GO_LIVE.md` table). Include Stripe, Supabase, Resend, Turnstile, Meilisearch,
   S3/R2, Vercel.
4. Seed-data realism: public aircraft categories (light/mid/heavy/ultra-long) and
   typical empty-leg routes (ZRH/GVA/NCE/LTN) — synthetic data only, no scraping.
5. First-20-operators outreach list source: public directories (EBAA/ARGUS/WYVERN
   operator lists) — list directory names + approach, no scraping.

Deliverable: this file completed + merged; feed findings into `GO_LIVE.md` and
`marketing/positioning.md`.
