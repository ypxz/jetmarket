# RESEARCH — JetMarket (PLAN.md §4)

> Status: **complete** — ticket T1. All facts verified on GitHub/vendor sites
> 2026-09-15. Feeds `GO_LIVE.md`, `marketing/`, and the seed worker (T11).

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
| Marketplace backend | write, not fork | medusa too heavy; sharetribe license-incompatible; our data model is small — confirmed by §1/§4 below |
| Design system | adopt `buildApps/template` tokens/primitives when it lands | template ETA ≤90 min |

## 1. OSS shortlist (verified on GitHub, 2026-09-15)

Shortlist of projects doing ≥50 % of the product *or* of a subsystem.
Fit % = share of JetMarket's scope the project already covers.

| Project | Stars | Last push | License | Fit | Verdict |
|---|---|---|---|---|---|
| `ixartz/SaaS-Boilerplate` | 7.4k | 2026-09-02 | MIT | ~55 % of *infrastructure* (Next.js + Tailwind + shadcn + auth/billing/i18n shell); 0 % of marketplace core | **read + pattern-reuse** — actively maintained; good reference for package layout, landing/pricing blocks, i18n wiring. Its auth is Clerk-based, so only the structure transfers, not the auth code. |
| `vercel/nextjs-subscription-payments` | 7.7k | 2025-01-23 | MIT (archived) | ~40 % of billing subsystem (Stripe subs + webhook → DB) | **pattern-reuse for `providers/payments`** — canonical Stripe subscription flow; archived, so copy ideas, not code. (`vercel/saas-starter`, named in the ticket, now 404s — repo removed/renamed; this is its surviving equivalent.) |
| `shadcn-ui/taxonomy` | 19.3k | 2026-04-20 | MIT | ~30 % — App Router structure, server components, content layers | **read for ideas** — ~5 months unmaintained and officially superseded; useful only as a structure reference. |
| `vercel/commerce` | 14.3k | 2026-08-13 | MIT | ~25 % — storefront/search/cart patterns | **read for ideas** — single-vendor e-commerce (cart/checkout), not a multi-operator RFQ marketplace. |
| `medusajs/medusa` | 36.3k | 2026-09-15 | MIT except `ENTERPRISE-LICENSE.md` dirs | ~30 % conceptually (catalog/orders); 0 % adoptable without taking the whole engine | **reject** — too heavy (own Node server, plugin system, Redis); retail-cart model ≠ RFQ. Read for data-model ideas only. |
| `sharetribe/sharetribe` (Sharetribe Go) | 2.4k | 2026-05-11 | **Sharetribe Community Public Licence 1.0** (source-available, not OSI) | ~50 % conceptually — a real two-sided marketplace (listings, transactions) | **ideas only** — license is incompatible with the MIT/Apache-2/BSD/ISC policy; also Ruby on Rails, retired product. Look at its listing/transaction state model for inspiration. |

Also checked and dropped: `t3-oss/create-t3-app` (MIT, 29k — a project generator, not a marketplace; template already prescribed), `n8n` (fair-code, irrelevant domain).

## 2. Competitors & willingness-to-pay (verified 2026-09-15)

| Competitor | What it is | Pricing (public) | Gap we exploit |
|---|---|---|---|
| **Avinode** | B2B wholesale charter marketplace (operators ↔ brokers); the industry default | Operator membership **$318/mo** (6/12-mo prepaid); broker tiers **$740 → $2,119/mo** + $128/mo per extra user; aircraft marketing slot $318/mo (avinode.com/pricing) | Insider network — no public buyer UX, no self-serve, fixed fee whether or not it produces. We are the open, retail-facing layer they aren't. |
| **XO** (Vista Global; absorbed JetSmarter) | Consumer charter app + marketplace on a fleet | Select Access **$250/mo + $50k refundable deposit** (or $5k/yr); $100k/$500k deposit tiers; non-members pay **$395 fee per booking** | Monetizes the *buyer* via membership walls. Our buyers are free; operators pay for supply-side value. |
| **Trade-A-Plane / Controller** (Sandhills Global) | Classified aircraft-for-sale ads, print + web | TAP **~$50–150/mo per listing**; Controller **~$300/mo** (reported; pricing via sales call) | Static classifieds — no RFQ, no quotes, no deal tracking, GA-era UX. Our sale listings plug into the same RFQ/quote/deal pipeline as charter. |
| **CharterPad** | B2B tool for charter professionals (20k-aircraft DB, trip board, empty legs) | Free tier; requires industry-association affiliation (NBAA/EBAA/ARGUS/WYVERN) | Gated to insiders; not a public demand channel. Complements, doesn't compete, with open distribution. |
| **Lunajets** (Geneva) | Retail charter broker, ARGUS-certified | All-inclusive quotes **€4k–14k/hr typical** (≈€2k turboprop → €40k+ ultra-long); 480-operator network; takes the broker margin | Broker opacity: buyers never see operators, operators can't merchandise. We're the transparent marketplace around the same inventory. |
| **SkyAccess** (emerging) | Free empty-leg listing channel | **$0/mo** — positions explicitly as the free Avinode alternative | Validates open-marketplace demand; we add RFQ workflow, quotes, aircraft-sale type, and a success-fee model. |
| ~~Stratajet~~ (dead) | Instant-booking pioneer (launched 2016, UK); US office closed 2017, faded | — | Lesson: fixed instant pricing on jets is fragile (availability/positioning complexity). RFQ → operator quotes is the resilient model — no need to out-engineer it on night 1. |

**Willingness to pay — confirmed.** Operators already pay Avinode **$318–2,119/mo fixed**
and classifieds **$50–300/mo**, largely without performance guarantees. JetMarket prices
under that fixed spend and adds pay-on-results alignment:

- **Pro listing $199/mo/operator** (unlimited listings, RFQ inbox, analytics) — undercuts
  the Avinode operator tier by ~40 % and includes a demand channel it lacks.
- **Free tier** 3 listings + delayed RFQs — supply-side funnel; converts to Pro once RFQs land.
- **Success fee 3 % charter / 1.5 % aircraft sale** — far below broker margins (typically
  5–10 %+ on charter, 5–10 % commission on sale brokerage) and only on closed deals.

## 3. API / ToS / key-obtainability matrix

Per `.env.example` provider. Buckets per PLAN.md §5: **local/offline** (no account),
**free-key** (agent could self-obtain: email only, no card/phone), **human-only**
(card, KYC, phone, or org decision).

| Env keys | Provider | Tonight | Key obtainability | Notes / docs |
|---|---|---|---|---|
| `DATABASE_URL` | Postgres 16 (docker-compose) | local | none needed | fully offline |
| `AUTH_PROVIDER` → Supabase | auth adapter | mock | `supabase start` = official local; hosted free tier = GitHub/email signup, no card → **free-key** | supabase.com/docs |
| `PAYMENTS_PROVIDER`, `STRIPE_*`, `STRIPE_API_BASE` | stripe-mock → Stripe | mock | stripe-mock via `pnpm db:up` = official contract target; live account needs card + KYC → **human-only** | stripe.com/docs, gh:stripe/stripe-mock |
| `EMAIL_PROVIDER`, `SMTP_URL`, `RESEND_API_KEY` | Mailpit → Resend | mock | Mailpit via `pnpm db:up` = official local; Resend free tier (≈3k/mo) = email-only signup → **free-key** | resend.com/docs |
| `STORAGE_PROVIDER`, `STORAGE_DIR` | local FS → S3/R2/Supabase | mock | AWS/R2 need account + card → **human-only**; Supabase storage via `supabase start` → free-key path | |
| `CAPTCHA_PROVIDER`, `TURNSTILE_SECRET_KEY` | mock → Cloudflare Turnstile | mock | Cloudflare account = email-only, Turnstile free/unlimited → **free-key** | developers.cloudflare.com/turnstile |
| `SEARCH_PROVIDER`, `MEILISEARCH_*` | Postgres FTS → Meilisearch | postgres | self-hosted OSS via docker = offline; cloud free tier email-only → **free-key** | meilisearch.com/docs |
| `ANALYTICS_PROVIDER` | mock | mock | PostHog/Umami free tier (email-only) or self-host → **free-key**, later | |
| `LLM_PROVIDER`, `OPENAI_KEY` | mock | mock | unused tonight; live OpenAI needs paid account → **human-only** | adapter stub kept for template parity |
| deploy target | Vercel / Fly.io | n/a | GitHub/email signup, hobby free → **free-key**; production choice = human decision | GO_LIVE.md |

ToS flags: nothing in the build path requires scraping, paid data feeds, or
regulated aviation data. Empty-leg/aircraft data is operator-entered or synthetic —
no competitor feeds are consumed (also a spec guardrail).

## 4. Fork / reuse / write — per subsystem

| Subsystem | Decision | Basis |
|---|---|---|
| Monorepo, framework, design system, i18n | **reuse** — Next.js 15 + template tokens/primitives + next-intl | spec §6; all MIT |
| Auth / billing / email / storage / captcha / analytics | **reuse via `packages/providers/*` adapters** — official SDKs + official mocks; `real.ts` = typed skeleton + `TODO(go-live)` where behavior needs a key | PLAN.md §5; billing flow modeled on `vercel/nextjs-subscription-payments`; module layout on `ixartz/SaaS-Boilerplate` |
| Marketplace core — listings, RFQ, quote pipeline, operator matching, fee ledger, `VerticalConfig` | **write** | no permissively-licensed OSS covers ≥50 %; sharetribe is license-blocked, medusa is the wrong domain + too heavy, vercel/commerce is single-vendor |
| Search | **write** on Postgres FTS + jsonb facets; Meilisearch adapter as optional skeleton | spec |
| Seed data | **write synthetic** | no scraping; realism rules in §5 |

## 5. Seed-data realism notes (input for T11 — `packages/db/seed`)

Synthetic but plausible. No scraped prices/listings. Direction of an empty leg
matters (it is a real positioning flight — keep city pairs one-way).

**Aircraft categories → typical models → seats / range (nm):**

| Category | Seats | Range (nm) | Typical models | Charter €/hr band | Used sale price band |
|---|---|---|---|---|---|
| Light | 6–8 | 1,500–2,100 | Embraer Phenom 300, Citation CJ3+/CJ4, Learjet 75, Pilatus PC-24 | €2.5–4.5k | $7–12M |
| Midsize / super-mid | 8–10 | 2,100–3,300 | Challenger 350, Citation Latitude, Legacy 450/500, Hawker 900XP, Citation XLS+ | €4.5–7k | $8–26M |
| Heavy | 10–14 | 3,400–4,500 | Falcon 2000, Challenger 650, Legacy 600/650, Gulfstream G450, Falcon 900 | €7–11k | $10–45M |
| Ultra-long-range | 12–19 | 6,000–7,700 | Gulfstream G650/G650ER, Global 6000/6500, Falcon 8X, Global 7500 | €11–20k+ | $35–70M |

(Price bands anchored to Lunajets' published €4k–14k/hr typical range, €2k turboprop
to €40k+ ULR; sale bands = plausible used-market ranges, synthetic.)

**Empty-leg city pairs (hub cluster per ticket: ZRH/GVA/NCE/LTN/LHR):**
ZRH–NCE, NCE–ZRH, GVA–NCE, NCE–GVA, ZRH–LTN, LTN–ZRH, GVA–LHR, LHR–GVA, LTN–NCE,
GVA–LBG (Le Bourget), ZRH–LIN (Linate), ZRH–IBZ, GVA–PMI, ZRH–ATH, BSL–NCE.

**Realism rules:**
- Empty legs price **30–50 % below** equivalent charter; dates near-term (next 3–21 days).
- Seasonality: NCE spikes (Monaco F1 May, Cannes, summer Med), ZRH (WEF/Davos January),
  BSL (Art Basel June), IBZ/PMI (summer), LHR/LTN year-round business flow.
- Listing mix for 60 listings: ~50 % charter, ~30 % empty_leg, ~20 % aircraft_sale;
  categories weighted light ≈ mid > heavy > ULR (market reality: light/mid dominate).
- Operator bases: concentrate on ZRH/GVA/Samedan/Lugano + LTN/FAB/LBG/NCE.

## 6. First-20 operators

→ `marketing/operator-outreach.md`: source directories (EBAA, ARGUS CHEQ, WYVERN
Wingman, ACA, NBAA, MEBAA, Aviapages), the 20 names, and the outreach email.
Public directories used for names/approach only — no scraping.
