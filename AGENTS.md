# Working in JetMarket

Monorepo rules an agent must follow — these exist because a specific QA cycle
found the bug once; don't reintroduce it.

## Gate commands (run before every commit)

```bash
pnpm lint                          # eslint + check:design + check:i18n (all packages)
pnpm typecheck                     # tsc --noEmit in EVERY package — a web-only tsc
                                   # misses test files in verticals/worker (QA-263)
cd apps/web && pnpm exec vitest run                    # unit
TEST_DATABASE_URL=postgres://jetmarket:jetmarket@localhost:5432/jetmarket_test \
  pnpm exec vitest run --config vitest.integration.config.ts test/integration/
# e2e — dedicated ports, serial workers:
cd tests-e2e && E2E_PORT=3100 TEST_DATABASE_URL=postgres://jetmarket:jetmarket@localhost:5432/jetmarket_test \
  pnpm exec playwright test --project=chromium --workers=1
# machinery vertical:
cd tests-e2e && VERTICAL=machinery E2E_PORT=3101 TEST_DATABASE_URL=... pnpm test:e2e:machinery
```

`.githooks/pre-push` runs `pnpm typecheck` + `pnpm lint` on every push —
auto-installed via `core.hooksPath` by the root `prepare` script on
`pnpm i` (no git dir → skipped, e.g. Docker). `git push --no-verify` skips.

`pnpm test:all` (root) is the full matrix — every package's unit +
integration + contract + both e2e suites. Run it after any repo-iface or
cross-package change and periodically during QA loops: per-suite checks
missed a web typecheck break once (QA-322).

Per-suite DBs: each integration/e2e suite owns its own `*_test` database
(`jetmarket_test` web+e2e, `jetmarket_db_test`, `jetmarket_worker_test`,
`jetmarket_providers_test` via `*_TEST_DATABASE_URL` overrides). NEVER point a
suite at another suite's DB — worker ticks mutate e2e fixtures (a stray
deliverDueMatches flips seeded delayed matches and breaks inbox specs, QA-266).
e2e global-setup drops+recreates the public schema, then migrate+seed.

Test DBs are destructive (drop `public` schema) — must end in `_test`.
Use dedicated `E2E_PORT`s: playwright's `reuseExistingServer` will otherwise
latch onto a stale dev server with an old module graph and give false failures.
`global-setup.ts` refuses to run against a reused server whose `/api/health`
reports a different `backend`/`vertical` than the suite needs (QA-289) — if it
errors, kill the stale `next dev` on the port. Specs pin `workers: 1` in
`playwright.config.ts` and isolate rate-limit buckets with a per-file
`fly-client-ip` header.

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
- Memory-repo mutators must be synchronous between check and write: an
  `await` inside a check-then-write yields the microtask queue and parallel
  callers interleave (QA-333 bit `createListing`'s cap, `createUser`'s email
  dedupe, `upsertSubscription`'s stale-gate). Drizzle does the same work
  under FOR UPDATE / ON CONFLICT — parity requires the memory side to never
  yield mid-mutation.

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

**Shared-DB isolation (QA-293..302):** two deploys may share one Postgres —
every per-vertical row carries `vertical` and every surface must scope by
`verticalSlug()`:

- List reads: pass `vertical` to `listRfqs`/`countRfqs`/`listListings`/
  `countOperatorListings`/`listListingCountsByOperator` (inbox, dashboard,
  admin, buyer self-service, sitemap, OG images).
- Single-row reads/mutations: after `getRfq`/`getListing`/`getJob`, 404 when
  `row.vertical !== verticalSlug()` — apply BEFORE any CAS/mutation so a
  rejected request can't already have flipped state.
- Worker: `WorkerDeps.vertical` is required; `claimJobs`, `expireRfqs`,
  fan-out queries all take it. `jobs.vertical IS NULL` = legacy/unscoped —
  claimable by every deploy's worker (deliberate).
- Quotes/deals have no vertical column: resolve via `quote.rfqId →
  rfq.vertical`. Operator-facing deal/funnel lists stay deliberately
  unscoped (a user's cross-vertical earnings are their business), but
  ADMIN deal surfaces are scoped — `listDeals`/`countDeals`/`sumDealFees`
  take `vertical` and the admin page + `/api/admin/deals` pass it
  (QA-313).
- Operators/users are global rows (no vertical). Fan-out candidates are
  scoped instead: `loadOperatorCandidates`/`fanoutRfq` exclude an operator
  whose book is entirely foreign-vertical (dealer elsewhere ≠ broker here);
  zero-listing operators keep the wildcard (QA-307).

## DB / migrations

Append-only `packages/db/migrations/NNNN_*.sql` — never edit an applied one;
the runner skips recorded files. Keep `schema.ts` and migrations in parity
(indexes + columns) — `pnpm check:schema` diffs declared tables/columns/
nullability against information_schema and runs inside `pnpm test:all`.
Scope data growth: pagination caps on every list read
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
