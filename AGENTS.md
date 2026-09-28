# Working in JetMarket

Monorepo rules an agent must follow — these exist because a specific QA cycle
found the bug once; don't reintroduce it.

## Gate commands (run before every commit)

```bash
pnpm lint                          # eslint + check:design + check:i18n (all packages)
cd apps/web && pnpm exec tsc --noEmit
cd apps/web && pnpm exec vitest run                    # unit
TEST_DATABASE_URL=postgres://jetmarket:jetmarket@localhost:5432/jetmarket_test \
  pnpm exec vitest run --config vitest.integration.config.ts test/integration/
# e2e — dedicated ports, serial workers:
cd tests-e2e && E2E_PORT=3100 TEST_DATABASE_URL=postgres://jetmarket:jetmarket@localhost:5432/jetmarket_test \
  pnpm exec playwright test --project=chromium --workers=1
# machinery vertical:
cd tests-e2e && VERTICAL=machinery E2E_PORT=3101 TEST_DATABASE_URL=... pnpm test:e2e:machinery
```

Test DBs are destructive (drop `public` schema) — must end in `_test`.
Use dedicated `E2E_PORT`s: playwright's `reuseExistingServer` will otherwise
latch onto a stale dev server with an old module graph and give false failures.

## Repo layer contract

Every `Repo` method must be implemented identically in
`lib/repo/memory.ts` AND `lib/repo/drizzle.ts` — extend the shared contract
suite (`test/integration/repo.contract.ts`) whenever you add one; it runs
against both impls. State transitions that must be atomic (quote accept, RFQ
close, listing activate under plan cap, magic-link consume) belong in the
repo layer as CAS/transactional writes — never read-check-write in a route.

- Match visibility: `delayed` rows are invisible until the worker flips them
  (`deliverAt` <= now). Both impls encode this (pg: `state <> 'delayed'` at
  read; memory: `deliverAt` read-time check).
- Terminal states: `archived` is operator-terminal (route enforces 403 on
  transitions out of it); `spam` RFQs are admin-set and invisible to workers.
- Dedupe: `createRfq` dedupeKey collides only against LIVE statuses — closed
  rows re-mint (partial unique index `rfq_dedupe_live`).

## Auth / sessions

- Magic links: GET `/api/auth/callback?token=…` verifies WITHOUT consuming
  (browser prefetch would burn single-use links); the form POST consumes via
  `consumeMagicLink` → `repo.consumeMagicLinkSig` (atomic insert). Never
  consume on GET.
- Logout bumps `session_version` — new session cookies embed it; drift = dead.
- Rate-limit every mutating route via `rateLimit(\`<name>:\${clientIp(req)}\`)`;
  `clientIp` prefers `fly-client-ip` → `x-real-ip` → last `x-forwarded-for`
  entry (tests override with `fly-client-ip: 10.x.x.x`).

## Notifications

Every state-changing action that affects another party must email them via
`lib/notify.ts` (non-fatal: try/catch + `logWarn`, never fail the request):
quote decline/withdraw, deal close (both parties), listing moderation,
verify toggle, invoice paid/void. Exceptions: RFQ spam-marking is
deliberately silent. Operator-facing RFQ views go through `operatorRfqView` —
it strips contact fields and never carries `accessToken`/`buyerEmail`
(masks until deal-close; the marketplace intro is the fee).

## Client forms

Every `"use client"` submit form needs a hydration gate — mount-set state
(`ready`/`loaded`/a required-field fetch) that disables submit until React
owns the handlers. A pre-hydration click natively GETs/POSTs the page route
and loses input. Action buttons use `sendAction` + `disabled={pending}` and
render errors via `role="alert"`.

## Vertical modularity

Nothing jets-specific may be hard-coded: listing types, facets, RFQ fields
(+ `type:"email"` = the buyer-contact field, exactly one per listing type),
fee table, plans (`fees.subscriptionPlans`), `matching` shape, expiry rules,
SEO landing pages, copy namespace — all read `getVertical()` /
`verticalConfig()`. `VERTICAL=machinery` must boot with zero code changes;
its e2e spec proves it.

## DB / migrations

Append-only `packages/db/migrations/NNNN_*.sql` — never edit an applied one;
the runner skips recorded files. Keep `schema.ts` and migrations in parity
(indexes + columns). Scope data growth: pagination caps on every list read
(route-level `?limit` clamped ≤200), retention prune for terminal jobs,
`updatedAt` bumped on every write.

## SEO / indexing

`noindex,nofollow` on every non-landing surface: /search, /quotes, /rfq/*,
/app, /admin, /design, sign-in, auth callback. robots.txt + sitemap advertise
only indexable routes (listings, SEO landing slugs, operator profiles,
legal). Bearer tokens travel in URL fragments (`#t=`) — never query params —
so they can't leak into access logs; `?t=` still accepted for already-emailed
links and stripped via `replaceState`.

## Providers

`packages/providers/<service>/{types,mock,real,index}.ts`; `mock` is the
default and must run the product fully offline. Real impls that aren't wired
throw `todoGoLive` (typed skeleton) — see `GO_LIVE.md` for the flip list.
License policy: MIT/Apache-2/BSD/ISC only; record deps in `THIRD_PARTY.md`.
