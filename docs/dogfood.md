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

## Screenshots

`docs/screens/cycle1-*.png` (17 shots; pre-template CSS on early shots —
template adoption landed mid-run).
