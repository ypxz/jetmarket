# Dogfood log (T20)

Fresh-user QA cycles against mock mode. Bugs filed as tickets in `TASKS.md`
(QA-*), screenshots per run in `docs/screens/`.

## Cycle 1 — H+3:00 (interrupted mid-run, coverage ~80%)

**Setup:** `pnpm dev`, mock providers, fresh operator/buyer/admin accounts;
desktop Chromium + 390px mobile viewport. No theme toggle exists → dark mode
untestable this cycle (QA-8).

**Flow covered:** sign-in (devlink) → operator onboarding → 3 listings → 4th
blocked by free limit (402 + upgrade CTA) → RFQ inbox → quote send → buyer
/quotes accept → admin verify + fee ledger ($6,000 → $180 = 3% ✓, $7,000
mobile ✓) → mock checkout → Pro badge + unlimited listings.

**Filed:** QA-1 (accept leaves RFQ `quoted`, dashboard counts open) · QA-2
(negative seats accepted) · QA-3 (mobile header overflow 554px @390px) · QA-4
(no busy state on Publish → duplicate listings) · QA-5 (raw `listingTypes.*`
labels in type select) · QA-6 (copy promises delayed RFQs for free/unverified;
immediate in reality) · QA-7 (no sign-out control) · QA-8 (no dark mode — idea).

**Passed highlights:** magic-link devlink flow, 402 plan limit + upgrade CTA,
fee math 3%, admin ledger + verify toggle, checkout→Pro, quotes persist across
reload, accept button hides after accept.

**Gaps deferred to cycle 2:** mobile admin/landing, fresh-publish mobile run,
`/search` nav-link journey end-to-end, clean uninterrupted recording.

**Cycle-1.5 (same day):** remaining coverage closed via the promoted
`e2e/core-loop.ui.spec.ts` — real browser loop on W3's shipped pages:
hero/facet search → listing → RFQ → thanks → inbox quote → buyer accept →
admin ledger → 402 → checkout → lifted. Green locally (3/3 specs incl. API
twin + smoke).

## Cycle 2 — Postgres, desktop + mobile 390px (clean recording)

Run on a clean branch off merged main at the time (predated the PR#14/15/18
fix wave): mock auth/email/payments, real Postgres via `packages/db`.
Recording: `~/screencasts/jetmarket-cycle2/jetmarket-cycle2-edited.mp4`;
screens in `docs/screens/cycle2-*.png` (27 shots).

**New findings:** QA-9 (**blocker** — `/tos` + `/privacy` 500 on missing
`legal.*` keys, `sections.map` crash) · QA-10 (`/imprint` raw keys +
placeholders) · QA-11 (year "2,020") · QA-12 (warning badge white-on-white) ·
QA-13 (mobile `/admin` tables need page-wide horizontal scroll) · QA-14
(empty-search copy offers an action that doesn't exist) · QA-15 (listing form
jets-hardcoded — machinery creation impossible via UI) · QA-16 (machinery
dashboard still jets copy).

**Stale-base reproductions (not regressions):** QA-1/2/3/4/5/7 showed on this
base; fixes landed mid-run in PR#14/15/18 — verify on main next cycle.

**Passed highlights:** fresh desktop + mobile operator onboarding and publish;
faceted + seat-range search; public RFQ→thanks; inbox quote→buyer accept;
admin verify + ledger ($6,000/3%/$180); mock checkout→Pro (3/3→unlimited);
mobile hero-search→RFQ journey; `/search` nav journey; design-gallery
controls.

**Machinery spec promoted:** `e2e/machinery.spec.ts` in the env-gated
`machinery` Playwright project — `pnpm --filter @jetmarket/tests-e2e
test:e2e:machinery` boots the webServer with `VERTICAL=machinery`; the spec
self-skips under jets so `test:e2e` stays green. Listing creation goes through
the API until QA-15 lands.

## Cycle 3 — wave-4 regression (QA-1..17 verify + lifecycle)

All prior findings confirmed fixed on main (`verify`): accept→RFQ closed +
dashboard count, negative-seats 422, publish dedup, translated type labels,
sign-out + dark-toggle persist, legal pages render, year plain, per-vertical
dashboard copy, config-driven listing form.

**New findings:** QA-18 (re-quote → 500 on `(rfq_id,operator_id)` unique —
pinned in `e2e/lifecycle.api.spec.ts`) · QA-19 (no portal button on billing) ·
QA-20 (mobile header nav still wraps over logo) · QA-21 (outbound mail
missing `From:` header in Mailpit) · QA-22 (oversized photo → bare "failed").

**New coverage:** `e2e/lifecycle.api.spec.ts` — decline (403→200→409),
accept-after-decline 409, withdraw (401→200→409), re-quote 500 (QA-18),
accept→invoiced, mark-paid (403→200→409), ledger paid row.

Machinery: `test:e2e:machinery` now defaults `E2E_PORT=3101` — avoids
attaching to a jets dev server on :3000 via reuseExistingServer.

## Screenshots

`docs/screens/cycle1-*.png` (17 shots; pre-template CSS on early shots —
template adoption landed mid-run). `docs/screens/cycle2-*.png` (27 shots).
`docs/screens/cycle3-*.png` (16 shots; run interrupted mid-cycle — lifecycle
coverage completed at spec level instead).
