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
| T11 | [x] W2 | Seed data: 15 operators, 60 listings incl. empty legs ZRH/GVA/NCE/LTN; realistic synthetic | `packages/db/seed/**` | `db:seed` idempotent; photos via storage mock |
| T12 | [x] W3 | SEO route pages from `vertical.seo.landingPages` (e.g. "empty legs Zurich–Nice") | `apps/web/app/(seo)`, `packages/verticals/*/seo.ts` | ≥10 route pages per vertical, sitemap.xml |
| T13 | [x] W2 | RFQ fan-out matching: RFQ → N operators by fleet fit + notify via email adapter | `packages/domain/matching*`, `apps/worker/**` | unverified operators get delay; unit-tested |
| T14 | [x] W2 | Success-fee invoices: deal→invoice record→payments adapter (mock + stripe-mock) | `packages/domain/fees*`, `apps/web/app/api/invoices`, admin ledger UI | 3% charter/1.5% sale; invoice appears in admin |
| T15 | [x] W1 | Rate limit + honeypot + captcha adapter on RFQ/public forms | `apps/web`, `packages/providers/captcha` | >RFQ_RATE_LIMIT/hour → 429; e2e covers |
| T16 | [x] W3 | Machinery vertical proof: `VERTICAL=machinery` boots, placeholder taxonomy, same flow e2e | `packages/verticals/machinery`, e2e spec | second acceptance e2e passes |
| T17 | [x] W1 | i18n/completeness + currency formatting; a11y pass; empty/loading/error states | `apps/web`, `packages/i18n` | grep: no string literals in apps; a11y e2e on core loop |
| T18 | [x] W1 | Ops: health endpoint, structured logging, Dockerfile web+worker, deploy notes | `apps/*`, `Dockerfile*`, `docs/deploy.md` | `docker build` green; `/api/health` 200 |
| T19 | [x] W1 | Marketing kit: positioning vs Avinode/XO/Stratajet, operator outreach email, 10 SEO titles, LinkedIn post, first-20-operators list | `marketing/**` | per spec §"Marketing kit" |
| T20 | [~] W4 (from H+2:30) | QA/dogfood loop worker (from H+2:30): fresh-user runs, files findings here, verifies fixes | reports only; files tickets | ≥1 cycle/90 min; cycle count + bugs logged to STATUS |
| T21 | [x] W2 | Billing checkout via payments provider: checkout + webhook→subscription; mock keeps e2e contract | `apps/web/app/api/billing/**` | Pro upgrade e2e still green through provider path |
| T22 | [x] W2 | Email provider swap: sendMail → `emailProvider().send` everywhere | `apps/web/lib/outbox.ts`, api routes | outbox files still readable by e2e/contract |
| T23 | [x] W3 | Listing photos via storage provider (mock writes local/serve path) + render on public listing card/detail | `packages/providers/storage`, `apps/web` listing forms/cards | photo upload+render works offline in mock |
| T24 | [x] W1 | Analytics events wired (rfq_created/quote_sent/deal_closed/page_view) via `analyticsProvider()` | `apps/web` api routes, `packages/providers/analytics` | events land in mock sink; unit-covered |
| T25 | [x] W1 (PR#34) | Listing + SEO pages: OG/Twitter meta + JSON-LD (Product/Vehicle offers) | `apps/web` listing/[id], (seo)/[slug] | view-source shows canonical+og+jsonld; no literals |
| T26 | [x] W1 | MORNING_REPORT draft + screenshots (`docs/MORNING-REPORT.md`, `docs/screens/`) | `docs/**`, `marketing/**` | real test counts + CI link + GO_LIVE digest + confidence score |
| T27 | [x] W2 | Quote lifecycle depth: decline (buyer) + withdraw (operator) routes, RFQ expiry sweep in worker (open rfqs past dateTo → expired, sent quotes → declined), admin "mark invoice paid" | `apps/web/app/api/**`, `apps/worker/**`, repo iface if needed | unit + integration; e2e decline path |
| T28 | [x] W3 | Lifecycle UI: buyer quotes page gets decline/accept buttons + state badges; operator RFQ detail shows sent quotes + withdraw; admin deals get invoice-paid action | `apps/web` (app)/quotes, (app)/rfqs/[id], (admin)/admin | decline+withdraw+paid round-trip works in UI; i18n clean |

## QA findings (T20 dogfood)

| # | Severity | Finding | Status | Owns |
|---|----------|---------|--------|------|
| QA-1 | bug | Accepting a quote creates the deal/fee ledger entry but the RFQ stays `quoted` and the operator dashboard still counts it open (repro: $6,000 + $7,000 quotes; accept persists, Accept button correctly disappears) | fixed (PR#18: setRfqStatus→closed) | `apps/web/app/api/quotes/[id]/accept`, repo status transition |
| QA-2 | bug | Negative `seats` accepted on listing publish (−2 → listing goes active) | fixed (PR#14: zod attr validation → 422) | `apps/web` listing form/API validation, `packages/verticals` schema |
| QA-3 | bug | Mobile 390px viewport: operator header overflows — document width 554px; email + nav clip. Empty-leg date/model placeholders clip too | fixed (PR#15) | `apps/web` app shell/header |
| QA-4 | bug | Publish button has no busy state: double-click creates duplicate listings (repro: two identical "Fourth Charter" rows) | fixed (PR#15: pending state) | `apps/web` listing form |
| QA-5 | polish | Listing-type selector shows raw i18n keys (`listingTypes charter`, `listingTypes empty leg`, `listingTypes aircraft sale`) post-template | fixed (PR#14: vertical-namespace labels) | `packages/i18n`/`apps/web` type select |
| QA-6 | polish | Dashboard/billing copy promises delayed RFQs for free/unverified operators, but RFQs arrive immediately | fixed (copy softened to review wording; delay claim returns with T13) | copy vs T13 matching behavior — align |
| QA-7 | polish | No sign-out / account-switch control (must navigate to `/sign-in` manually) | fixed (PR#15) | `apps/web` app shell |
| QA-8 | idea | No dark mode / theme toggle reachable | fixed (header toggle, .dark tokens) | `packages/ui`, `apps/web` |
| QA-9 | blocker | `/tos` and `/privacy` 500 "Something went wrong" — `legal.*` message keys missing; `sections.map is not a function` | fixed (PR#29) | `apps/web` legal pages, `packages/i18n` |
| QA-10 | bug | `/imprint` renders raw `legal.imprint.*` keys; entity/address/registration/contact all placeholders | fixed (PR#29) | `apps/web`, `packages/i18n` |
| QA-11 | bug | Year renders as "2,020" in public listing cards/detail (locale number grouping applied to year) | fixed (PR#29) | `apps/web` listing display |
| QA-12 | polish | Warning/unverified badge text nearly white-on-white, incl. `/design` Warning badge | fixed (PR#28) | `packages/ui` badge tokens |
| QA-13 | bug | Mobile 390px: `/admin` deal/operator tables need page-wide horizontal scroll — Verify + invoice columns unreachable without it | fixed (PR#28) | `apps/web` admin tables |
| QA-14 | polish | Empty search results suggest sending an "open RFQ" but provide no such action/link | fixed (PR#28) | `apps/web` search empty state |
| QA-15 | bug | `/app/listings/new` is jets-hardcoded (seats/model/from/to/date): under `VERTICAL=machinery` required attrs (machineryCategory/make/yearOfManufacture) have no inputs → UI listing creation impossible; e2e creates via API | fixed (PR#27) | `apps/web` listing form per-vertical |
| QA-16 | polish | Machinery operator dashboard still shows jets copy ("Create your first charter, empty leg or aircraft sale") | fixed (PR#29) | `apps/web` dashboard i18n per-vertical |
| QA-17 | bug | Intermittent `SyntaxError: Unexpected end of JSON input` → 500 on `/app` in dev (e2e server logs); triggers Fast Refresh full-reloads that clear in-progress form state mid-session | fixed (PR#33) | `apps/web` — likely a client `JSON.parse`/`fetch` on `/api/vertical` or dashboard data |
| QA-18 | bug | Operator can only send ONE quote per RFQ: `POST /api/quotes` after decline/withdraw hits unique `(rfq_id,operator_id)` → **500** raw constraint error (should be clean 409 or allowed re-quote). `e2e/lifecycle.api.spec.ts` pins current 500 — flip when fixed | fixed (PR#40) | `apps/web/app/api/quotes`, `packages/db` quotes unique |
| QA-19 | polish | `/app/billing` shows Pro "Active until …" but no portal/manage-subscription button — `POST /api/billing/portal` exists unused | fixed (PR#39) | `apps/web` billing page |
| QA-20 | bug | Mobile 390px: header still overlaps — nav wraps over the "JetMarket" logo text ("Sign out" drops below); QA-3's fix covered dashboard width, not nav wrap | fixed (PR#39) | `apps/web` app shell/header |
| QA-21 | bug | Outbound emails (magic link, quote, deal, RFQ fan-out) reach Mailpit with **no `From:` header** — real SMTP providers will reject | fixed (PR#40) | `packages/providers` email adapter |
| QA-22 | polish | Oversized photo upload → bare "failed" text under file input — no size-limit message despite "up to 5 MB each" hint | fixed (PR#39) | `apps/web` listing form upload UX |
| QA-23 | polish | Seeded listing photos 404: `GET /storage/seed/<op>/<slug>-p0.svg` → 404 for all ~105 seeded photos — DB has photo rows but storage mock has no files | fixed (lead — seed writes to apps/web/storage via import.meta anchor, not pkg cwd) | `packages/db` seed + `packages/providers/storage` |

## Improvement-loop log (append per cycle)

| Cycle | Time | Findings filed | Fixed | Notes |
|---|---|---|---|---|
| 1 | H+3:00 | QA-1..QA-8 (4 bug, 3 polish, 1 idea) | — | Fresh-user run, mock mode, desktop+mobile(390px). Interrupted mid-run by concurrent merge/next-dev — mobile admin/landing + clean rerun deferred to cycle 2. Screens: docs/screens/cycle1-* |
| 2 | H+4:30 | QA-9..QA-16 (1 blocker, 4 bug, 3 polish) | — | Clean recorded run, real Postgres, desktop + mobile 390px: full operator→buyer→admin loop incl. mobile onboarding/publish + hero-search→RFQ. Ran on pre-PR#14/15/18 base — QA-1/2/3/4/5/7 reproduced there; re-verify on main next cycle. Machinery spec promoted (env-gated `machinery` project, `test:e2e:machinery`). Screens: docs/screens/cycle2-*; recording in screencasts/ (not committed) |
| 3 | H+8:00 | QA-18..QA-22 (3 bug, 2 polish) | QA-1..17 verified fixed on main | Regression on wave-4 main: QA-1/2/4/5/7/8 screenshot-verified (accept→closed, 422 negative seats, dedup publish, translated types, sign-out, dark persist); legal+T23 photos confirmed working. New `e2e/lifecycle.api.spec.ts` covers T27/T28 round-trips + 403/409 edges; expiry sweep stays worker-unit-tested. Agent run interrupted mid-cycle — completed via spec-level regression. Screens: docs/screens/cycle3-* |
| 3b | H+9:30 | QA-23 (polish) + lifecycle regression | — | Wave-4 regression: `e2e/lifecycle.api.spec.ts` green (decline/withdraw/mark-paid + 403/409 edges + QA-18 pinned). Full suite 6 pass/1 skip. Seed-photo 404s found in server logs (QA-23) |
| lead | ~18:50 | — | — | Machinery seed landed: `VERTICAL=machinery pnpm db:seed` → 8 dealers/17 listings (for_sale/for_rent/auction), schema-validated against vertical config, photos to storage mock; seeds coexist with jets rows in one db |
| 6 | ~22:45 | — (none) | jets e2e regression green | Lead-run (W4 still SWE-2-cap-blocked): `test:e2e` 6 pass/1 skip against Postgres — core-loop UI+API, quote-decline UI, lifecycle API, RFQ abuse all green |
| 5 | ~21:45 | — (none) | machinery loop green | Lead-run locally (W4 suspended — org SWE-2 cap): `test:e2e:machinery` green — machinery RFQ→quote→accept→deal incl. 2% fee event; SEO page /en/used-forklifts-for-sale renders seeded listings. Prior dev spot-check: machinery search/facets render seeded stock |
| 7 | ~03:50 | — (none) | search pagination shipped | Lead-run (W4 cap-blocked): `/search` gained `page` param — 24/page, prev/next pager preserving filters, clamps 0/neg/float/non-numeric/out-of-range. Verified on seeded pg: 64 listings → Page 1..3, `type=empty_leg` → 28 → 2 pages, hrefs keep facet params. Unit: +5 paginate tests (13 pass). Bogus listing id → not-found render confirmed |
| 8 | ~05:05 | — (none) | pager generalized; rfqs+admin paginate | Lead-run: `SearchPager`→`Pager(basePath)` reused on `/app/rfqs` + `/admin` deals (24/page, `page` param, clamps). Ledger header keeps all-deals count + fee total (not page slice). Pager i18n moved to `common.pager`. e2e spec testid→`pager`. Build green (34 routes), live-verified Page 1 of 3 |
| 9 | ~05:25 | QA-24 (bug, fixed same cycle) | memory↔drizzle ordering parity | Lead-run: `memory.listListings` returned insertion order vs drizzle `desc(createdAt)` — newest listings landed last in memory mode / page-1 mismatch. Fixed + contract test pins newest-first on both backends (memory+drizzle integration green) |
| 10 | ~05:55 | QA-25 (bug, fixed same cycle) | rate-limit coverage on write POSTs | Lead-run: per-IP hourly limits added — magic-link 30/ip + 10/inbox, uploads 30, quotes 60, listings 40 (match RFQ helper pattern, globalThis buckets). Abuse spec extended: per-inbox cap 429s on the 11th call, first 10 clean. E2E-safe ceilings (suite shares `local` ip) |
| 11 | ~06:10 | QA-26 (bug, fixed same cycle) | SEO index surface audit | Lead-run: robots prefix-match missed `/en/*` locale paths (as-needed routing still accepts them) — `/en/app`, `/en/admin`, `/en/search`, `/en/quotes` were indexable; also added `/search`, `/quotes` non-prefixed. Sitemap advertised search/quotes/sign-in/design (noindex surfaces) — trimmed to indexable-only + SEO slugs |
| 12 | ~06:30 | QA-27 (bug, fixed same cycle) | error-boundary + metadata gaps | Lead-run: adopted template's global-error.tsx + root not-found.tsx (own html/body, hardcoded-EN fallback); /_not-found now in build manifest. metadataBase was unset → OG images resolved to localhost — now `new URL(siteUrl())` |
| 13 | ~07:15 | QA-28 (bug, fixed same cycle) | middleware matcher vs extensionless storage keys | Lead-run: `/storage/<key>` without a file extension was locale-rewritten → 200 HTML for what should be an image (verified live). Added `storage` to matcher exclusion; now hits real route. Streaming soft-404 on notFound() noted as accepted Next tradeoff |
| 14 | ~07:45 | — (verify-only, no finding) | auth/API surface audit | Lead-run: `/api/operators` GET self-scoped 401 public; `/api/admin/*` 403; quote accept/decline enforce buyerEmail ownership + state machine + closes competing quotes; buyer quotes API returns operator {name,verified} only. No PII leak found |
| 15 | ~08:10 | QA-29 (bug, fixed same cycle) | quote-accept missing parent-state guard | Lead-run: accept checked `quote.status` but not `rfq.status` — a `sent` quote on a closed/expired RFQ (sweep lags or worker off) could mint a deal. Guard added: rfq must be open/matched/quoted → 409 otherwise |
| 16 | ~08:35 | QA-30 (bug, fixed same cycle) | quote-create only blocked 'closed' RFQs | Lead-run: expired/spam RFQs accepted new quotes — live-state guard (open/matched/quoted) now on both create and accept. `RfqStatus` type widened to include db-side `matched`/`spam` that reads emit |
| 17 | ~09:00 | QA-31 (bug, fixed same cycle) | unbounded JSON body | Lead-run: `parseBody` read `req.json()` with no size cap — large bodies buffered fully into memory. 64KB ceiling added (header fast-path + post-read check for chunked). Verified live: 70KB → 413, normal body → schema 422 |
| 18 | ~09:30 | QA-32 (bug, fixed same cycle) | PATCH listing bypassed parseBody | Lead-run: raw `req.json()` — no body cap, no schema. Now zod `status` enum via parseBody; grep confirms zero raw req.json() left in api routes |
| 19 | ~10:00 | QA-33 (bug/security, fixed same cycle) | svg stored-XSS on /storage | Lead-run: operator uploads allowed svg → served inline `image/svg+xml` → top-level nav executes same-origin script. Fix: svg responses get CSP `default-src 'none'` + `attachment` + `nosniff` (verified live); svg removed from upload allowlist; img-tag rendering unaffected |
| 20 | ~10:20 | QA-34 (hardening, fixed same cycle) | missing response security headers | Lead-run: next.config had none — adopted template block (nosniff/Referrer-Policy/X-Frame-Options SAMEORIGIN/Permissions-Policy). Verified live on / |
| 21 | ~10:50 | QA-35 (bug/security, fixed same cycle) | auth-callback open redirect | Lead-run: `next=https://evil.com` resolved absolute over base → session cookie rode to attacker domain. Now site-relative only (`/x`, not `//x`); `secure` flag added on https. Cookie already httpOnly+samesite=lax |
| 22 | ~11:30 | — (verify-only, no finding) | full e2e regression after security wave | Lead-run: 8 pass / 2 skip locally on latest main — core-loop UI, pagination, abuse caps, machinery, lifecycle all green post QA-25..35 |
| 23 | ~11:55 | — (verify-only, no finding) | withdraw/decline ownership + i18n render probe | Lead-run: withdraw checks operator ownership + sent-status; decline checks buyerEmail + sent. All public routes render with zero missing-key errors on live dev |
| 24 | ~12:20 | QA-36 (bug, fixed same cycle) | select rfqFields rendered as text inputs | Lead-run: `type: "select"` → `type="text"` Input, ignoring `options` — any vertical using select would 422 on enum check. Now real `<Select>` w/ placeholder + options; no current vertical uses it, contract now honest |
| 25 | ~12:40 | — (verify-only, no finding) | (app)/(admin) auth gates under streaming | Lead-run: anon /app + /admin stream a 200 shell carrying the redirect → client lands on sign-in; rendered body is sign-in content only, no app/admin data leaks. Acceptable Next streaming behavior |
| 26 | ~13:05 | — (verify-only, no finding) | THIRD_PARTY dep audit | Lead-run: full package.json sweep — every external dep already listed or MIT/ISC dev tooling (tsx/eslint/tsc-eslint/coverage/@types/@tailwindcss-postcss row added) |
| 27 | ~13:55 | QA-37 (bug, fixed same cycle) | createUser race + case dupes | Lead-run: ported template `4e65c55` — read-then-insert on unique email → 23505 on concurrent magic-links; `onConflictDoNothing` + re-read winner now. Email lowercased on both backends (was drizzle-only path that stored raw) |
| 28 | ~14:45 | QA-38 (bug, fixed same cycle) | worker fan-out ignored RFQ state | Lead-run: `rfq.fanout` fanned out + re-marked closed/expired RFQs `matched`, emailing operators for dead requests. Guard: `new`-only + conditional markRfqMatched. +1 worker test (7 total) |
| 29 | ~15:20 | QA-39 (authz hole, fixed same cycle) | buyer quotes gate | Lead-run: `/api/buyer/quotes` + accept/decline gated on **bare email** — knowing a buyer's email exposed + could act on all their quotes. Shipped `rfqs.access_token` (migration 0003); the email link / thanks redirect carries `?t=`; bare-email lookup removed. 13 contract + 43 unit + 8 e2e green |
| 30 | ~15:45 | QA-30 (verify) | machinery smoke on post-QA-39 main | Lead-run: VERTICAL=machinery e2e — full loop incl. bearer-token buyer flow green; 2% for_sale fee correct |
| 31 | ~16:05 | QA-40 (authz hole, fixed same cycle) | billing webhook auth | Lead-run: mock-mode `POST /api/billing/webhook` accepted unsigned JSON → free-Pro activation for any operatorId (checkout emulates in-process, nothing legit calls it). Now requires `x-mock-webhook-secret` = `MOCK_WEBHOOK_SECRET`; closed when unset. Verified 403 live |
| 32 | ~16:15 | QA-41 (vuln, fixed same cycle) | operator inbox leak | Lead-run: `GET /api/operator/rfqs` spread the full rfq incl. `accessToken` — an operator could impersonate the buyer and self-accept quotes. Token stripped from the payload (buyerEmail kept: designed inbox UX; off-platform circumvention remains a known business trade-off) |
| 33 | ~16:40 | QA-42 (race, fixed same cycle) | stale webhook ordering | Lead-run: ported template `a920f91` — `subscriptions.last_event_at` (migration 0004) + `setWhere` stale gate; `applyPaymentEvent` pre-checks so a late `canceled` can't downgrade plan while the newer sub row stays. +1 contract test (16 total) |
| 34 | ~17:00 | QA-43 (coverage) | PATCH listing e2e | Lead-run: lifecycle spec gains PATCH block — buyer 401, non-owner operator 404, owner pause→reactivate 200 |
| 35 | ~17:10 | QA-44 (vuln, fixed same cycle) | session forgery | Lead-run: `SESSION_SECRET` fell back to a hardcoded string in every env — on any deploy missing the var, anyone could sign `userId.sig` for admin access. Now throws when NODE_ENV=production without it; also `timingSafeEqual` + sig-length check |
| 36 | ~17:30 | QA-45 (verify) | fresh-DB migrate+seed | Lead-run: all 4 migrations apply clean on an empty database (access_token + last_event_at columns), jets seed green — fresh-clone path intact post-security wave |
| 37 | ~18:25 | QA-46 (verify) | machinery e2e | Lead-run: machinery spec green on the new bearer-token buyer flow (2% for_sale fee asserted) — vertical parity intact |
| 38 | ~19:05 | QA-47 (type drift) | deal invoiceStatus | Lead-run: schema enum had 'void' but `Deal.invoiceStatus` cast hid it — widened union, added badge variant + i18n label |
| 39 | ~20:10 | QA-48 (race) | double-accept → duplicate deal | Lead-run: two concurrent accepts could both pass the 'sent' check — memory impl created a second deal, drizzle 500'd on the unique constraint. Now both reject; accept returns 409. Contract test added |
| 40 | ~20:45 | QA-49 (hardening) | rate-limit bucket leak | Lead-run: `rateLimit` Map never evicted keys — a rotating-IP flood grew memory unboundedly. Now empty keys deleted, expired swept at 10k, full clear as last resort |
| 41 | ~21:15 | QA-50 (gap) | admin void-invoice | Lead-run: schema enum allowed 'void' but no route/UI reached it — added POST /api/admin/deals/[id]/void + deals-table button |
| 42 | ~23:20 | QA-52 (verify) | mobile 390px | Lead-run (W4 capped): playwright sweep — /search + landing + /rfq + /sign-in, no horizontal scroll, filters stack cleanly |
| 43 | ~00:00 | QA-53 (gap) | operator listing controls | Lead-run: dashboard listed listings with no actions — PATCH API unreachable from UI. Added per-row pause/publish/archive buttons |
| 44 | ~01:10 | QA-54 (a11y) | facet range inputs | Lead-run: min/max inputs had no accessible name — aria-labels added; RFQ form verified fully labeled |
| 45 | ~01:40 | QA-55 (feature) | listing edit | Lead-run: operators couldn't edit title/price — PATCH extended (attrs merged through per-type schema, 404 for non-owner), `updateListing` on both impls, /app/listings/[id]/edit page, contract + e2e green |
| 46 | ~03:40 | QA-55b | listing attr edit | Lead-run: edit page now fetches vertical attribute schema and renders prefilled per-type fields; PATCH merges via .partial() schema |
| 47 | ~11:20 | QA-56 | repo pagination | Lead-run: listListings limit/offset + countListings on both impls; facet equality into SQL (\`->> k = v\`); /search uses repo-level count+slice when no range facet active |
| 48 | ~12:10 | QA-57 | e2e edit listing | Lead-run: new e2e/edit-listing.ui.spec.ts (dashboard→edit→save→dashboard→public page); helper now waits for async attr fields (createListing previously raced /api/vertical and saved attributes {}) |
| 49 | ~12:40 | QA-58 | repo facet ranges | Lead-run: facetRanges filter on both impls — attribute ranges via `->> k` regex-guarded ::numeric, price via priceMinor; /search pagination now repo-level even with ranges active; contract test pins price+attr+non-numeric cases |
| 50 | ~13:30 | QA-59 | inbox UX | Lead-run: /app/rfqs rendered a working quote form on closed/expired RFQs (API 409'd on submit — dead-end UX). Quote form + withdraw now gated on live states (open/matched/quoted); dead RFQs show a localized `notOpen` note |
| 48 | ~12:10 | QA-57 | e2e edit UI | Lead-run: no e2e covered PATCH edit flow (contract+api only). New edit-listing.ui.spec.ts (create→dashboard→edit→save→verify); fixed createListing race — it filled dynamic attrs before /api/vertical rendered them; waits for first attr testid now |
| 51 | ~13:50 | QA-60 | pagination | Lead-run: /app/rfqs fetched ALL of an operator's RFQs then sliced app-side (same N+1 QA-56 fixed for listings). listRfqs gained limit/offset; countRfqs added; inbox = countRfqs + listRfqs(limit,offset); contract test exercises both |
| 52 | ~14:00 | QA-61 | pagination | Lead-run: /app dashboard counted open RFQs by fetching every row (statusNot filter on countRfqs now); / fetched all active listings to slice 6 featured (limit:6 in repo call now). Pro dashboard listing list stays unbounded-by-design |
| 53 | ~14:15 | QA-62 | pagination | Lead-run: /admin fetched all deals + operators then paginate()'d app-side. listDeals/listOperators gained limit/offset; countDeals/countOperators added; admin page = countDeals + listDeals(slice); feeTotal now sums the visible page (was all-time) |
| 54 | ~14:25 | QA-63 | plan limit | Lead-run: POST /api/listings enforced FREE_LISTING_LIMIT but PATCH status:active on a paused/draft listing bypassed it — a free operator could archive→reactivate past the cap. PATCH now rechecks when transitioning non-active→active (archived excluded, same as create) |
| 55 | ~22:50 | QA-64 | pagination | Lead-run: GET /api/operator/rfqs returned every RFQ with full quote history — unbounded payload grew with operator tenure. Optional ?limit/&offset= now (max 100); default is one SEARCH_PAGE_SIZE page; bare-email callers unchanged |
| 56 | ~23:05 | QA-65 | spec gap | Lead-run: fan-out emails told matched operators to 'open your inbox' but listRfqs only joined via listingId and POST /api/quotes rejected non-owners — notification-theater. operatorId filter now ORs a pending rfq_match exists-clause; hasRfqMatch is the bearer in quote-create; memory impl returns false (no matches table — documented gap) |
| 57 | ~23:20 | QA-66 | pagination | Lead-run: GET /api/listings returned every active listing unbounded — grew with supply. Optional ?limit/&offset= (max 200); default one SEARCH_PAGE_SIZE page. Also f_* facet params are arbitrary jsonb keys — parameterized SQL so safe, noted |
| 58 | ~23:35 | QA-67 | pagination | Lead-run: /api/admin/deals + /api/admin/operators returned every row with per-row joins — unbounded admin payloads. Optional ?limit/&offset= (max 200, default 50); same pattern as QA-64/66 |
| 59 | ~23:50 | QA-68 | rate limits | Lead-run: operator upsert, listing PATCH, and all three quote lifecycle routes had no per-IP cap — a bot could spam edits/accepts. 30-60/hr caps added (accept/decline/withdraw 30, patch 60, upsert 30); admin + webhook + logout intentionally uncapped |
| 60 | ~23:59 | QA-69 | buyer quotes | Lead-run: accept/decline rendered for any sent quote even after its RFQ closed/expired (409 dead-end between expiry and sweep). Buyer page now gates on LIVE rfq states too |
| 61 | ~00:05 | QA-70 | billing | Lead-run: checkout + portal created provider sessions with no per-IP cap — 10/hr caps added |
| 62 | ~00:12 | QA-71 | buyer api | Lead-run: /api/buyer/quotes had no per-IP cap despite being the bearer-token auth surface — 60/hr cap added |
| 63 | ~00:35 | QA-72 | info leak | Lead-run: public `GET /api/listings*` and buyer `/api/buyer/quotes` embedded the full Operator row — `userId` (auth linkage) and `plan` (billing tier) left the server. `publicOperator` projection now ships name/baseAirport/fleetSummary/verified only |
| 64 | ~00:55 | QA-73 | info leak | Lead-run: post-QA-65, matched operators' inbox showed ALL quotes on the shared RFQ incl. competitor amounts — scoped `listQuotes` to the viewing operator in both `/api/operator/rfqs` and `/app/rfqs` |
| 65 | ~01:15 | QA-74 | unbounded read | Lead-run: admin page called `listOperators()` uncapped for the table — capped at 100 (header count already shows true total); `/api/admin/operators` was capped in QA-67 |
| 66 | ~01:25 | QA-75 | unbounded read | Lead-run: `/api/buyer/quotes` scanned all of a buyer's RFQs before the token filter — capped at 200 (post-fetch match needs headroom) |
| 67 | ~01:40 | QA-76 | unbounded render | Lead-run: SEO `[slug]` pages rendered the full filtered set via unbounded `searchListings` — added `limit` param (default 48); landing pages are teasers for /search which paginates |
| 68 | ~01:55 | QA-77 | expiry gap | Lead-run: expiry sweep only fired on `fields.dateTo` matching ISO — undated RFQs (machinery `dateTo` optional, malformed values) stayed open forever with live accept surface. 30-day stale horizon added (db CTE + memory + contract test) |
| 69 | ~02:05 | QA-78 | schema bounds | Lead-run: quote `amount` had no upper bound and listing POST accepted `price: 0` while PATCH demanded positive — both now `positive().max(1e9)` |
| 70 | ~02:15 | QA-79 | unbounded render | Lead-run: operator dashboard listed ALL own listings (uncapped `listListings`) — capped at 100, header count uses `countOperatorListings` |
| 71 | ~02:25 | QA-80 | seo | Lead-run: sitemap omitted individual `/listing/<id>` pages (the canonical-bearing indexable content) — active listings now listed, capped at 1000 |
| 72 | ~02:35 | QA-81 | search | Lead-run: `query` param interpolated raw into `ilike` — user `%`/`_` acted as wildcards; escaped for literal match |
| 73 | ~02:45 | QA-82 | schema bounds | Lead-run: `photos: z.array(z.string())` unbounded — capped at 12 keys/300 chars each |
| 74 | ~02:55 | QA-83 | authz lifecycle | Lead-run: `hasRfqMatch`/inbox required `state='pending'` but notify flips to `sent` — matched RFQs vanished post-email; `<> 'delayed'` keeps delivered access |
| 75 | ~03:05 | QA-84 | info hygiene | Lead-run: `ListingCard` prop took the full `Operator` row (client-component overrides would serialize userId/plan) — narrowed to `PublicOperator`, callers project via `publicOperator()` |
| 76 | ~03:15 | QA-85 | config safety | Lead-run: unknown `REPO` value silently booted in-memory repo — now throws |
| 77 | ~03:25 | QA-86 | worker crash recovery | Lead-run: `requeueStaleJobs` existed but was never called — a mid-claim crash stranded jobs 'running' forever; tick now requeues >10min stale rows |
| 78 | ~03:40 | QA-87 | fan-out correctness | Lead-run: owner email ran only in memory mode (worker-dependent in pg); fan-out could self-match the listing owner; `enqueueJob` throw 500'd after persist — all three fixed |
| 79 | ~03:45 | QA-88 | observability | Admin invoice/verify writes were silent — logInfo(admin.deal_invoice_paid/voided, admin.operator_verify_toggled) with actor+target+new value |
| 80 | ~04:15 | QA-89 | memory-mode parity | Mock mode had no fan-out — only owners saw RFQs. POST /rfqs now runs domain matching inline (deliverAt lazy-gates delayed), flips rfq to 'matched', emails instant matches; +createRfqMatches on both impls + contract test |
| 81 | ~04:20 | QA-90 | perf | /api/buyer/quotes filtered rfqs by buyer_email with no index — migration 0005 adds rfqs_buyer_idx(buyer_email, created_at) |
| 82 | ~04:25 | QA-91 | ops | /api/health returned ok with a dead DB — now probes select 1 under DATABASE_URL and 503s on failure (verified live) |
| 83 | ~23:15 | QA-92 | deploy | .dockerignore lacked .env* — Dockerfile `COPY . .` would bake env files (and secrets) into images; added `.env*` + `!.env.example` exception |
| 84 | ~23:40 | QA-93 | ops | jobs table grew unboundedly (done/failed kept forever) — pruneJobs() deletes done>7d / failed>30d, wired hourly-throttled into worker tick; integration test covers retention boundaries |
| 85 | ~23:55 | QA-94 | info-leak | global-error.tsx rendered raw error.message — pg/SQL error internals could surface to users; now generic copy + error.digest correlation ref |
| 86 | ~00:05 | QA-95 | auth | Magic-link token WAS the session token — deterministic HMAC(userId), never expired, infinitely reusable, link==session so a stolen cookie minted more links. Now purpose-tagged `<id>.<iat>.<hmac>` — sessions 30d TTL, links 15min TTL, non-interchangeable; callback exchanges link→fresh session |
| 87 | ~00:15 | QA-96 | deploy verify | Both Dockerfiles verified end-to-end via ECR mirror (Docker Hub 429 persisted): worker image builds + boots + polls resiliently; web image builds standalone + serves /api/health 200 + landing 200 |
| 4 | H+11:00 | — (no new findings) | QA-18..23 verified fixed | Re-verify on main: re-quote 201/409 (lifecycle spec green, 6 pass/1 skip); portal button on /app/billing for pro; mobile 390px header no-overlap + /app/rfqs + /admin zero hscroll; Mailpit shows `From: JetMarket <noreply@jetmarket.local>` under EMAIL_PROVIDER=smtp; oversized upload → 422 "image must be between 1 byte and 5 MB"; seed photos 200 after re-seed. og:image verified: `/en/listing/<id>` emits og:image → PNG 200 1200×630. `pnpm dev` boots honoring PORT. Screens: docs/screens/cycle4-* |

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
