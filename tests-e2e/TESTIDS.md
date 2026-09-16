# TESTIDS — the e2e contract between app workers and tests

`data-testid` attributes the e2e suite relies on. Conventions:

- kebab-case, stable across restyles; never derive from translated copy.
- Row/list items get the entity id: `rfq-<id>`, `quote-<id>`, `deal-<id>`
  (locate with `[data-testid^="rfq-"]`).
- Dynamic vertical fields use their config key: `listing-<key>` on the listing
  form, `rfq-field-<key>` on the RFQ form, `facet-<key>` / `facet-<key>-option-<value>`
  in search facets.

## ✅ Already in the app (merged slice — do not rename)

| Area | testid |
|---|---|
| sign-in | `signin-email`, `signin-submit`, `signin-devlink` |
| operator dashboard | `onboarding-cta`, `operator-name`, `plan-badge`, `new-listing-cta` |
| onboarding form | `operator-name-input`, `operator-base-input`, `operator-fleet-input`, `operator-save` |
| listing form | `listing-type`, `listing-title`, `listing-category`, `listing-model`, `listing-seats`, `listing-price`, `listing-from`, `listing-to`, `listing-date`, `listing-save`, `upgrade-cta` (402 surface) |
| RFQ inbox (`/app/rfqs`) | `rfq-<id>` per row, `quote-amount-<rfqId>`, `quote-send-<rfqId>`, `rfq-empty` |
| buyer quotes (`/quotes`) | `buyer-email`, `buyer-load`, `buyer-rfq-<id>`, `quote-<id>`, `accept-<id>`, `decline-<id>`, `accept-msg` |
| admin (`/admin`) | `fee-ledger`, `deal-<id>`, `admin-op-<id>`, `admin-verified-<id>`, `verify-<operatorId>` |
| RFQ inbox (`/app/rfqs`) | `rfq-<id>` per row, `quote-amount-<rfqId>`, `quote-send-<rfqId>`, `op-quote-<id>`, `withdraw-<id>`, `rfq-empty` |
| buyer quotes (`/quotes`) | `buyer-email`, `buyer-load`, `buyer-rfq-<id>`, `quote-<id>`, `quote-state-<id>`, `accept-<id>`, `decline-<id>`, `accept-msg` |
| admin (`/admin`) | `fee-ledger`, `deal-<id>`, `admin-op-<id>`, `admin-verified-<id>`, `verify-<operatorId>`, `deal-invoice-<id>`, `mark-paid-<id>` |
| billing | `checkout-pro`, `pro-active`, `upgrade-cta`, `billing-portal` |
| landing (`/`) | `hero-search` (GET form → `/search?q=`) |
| search (`/search`) | `facet-sidebar`, `facet-q` (query input), `facet-<key>` (enum select) / `facet-<key>-min` + `facet-<key>-max` (number-range), `facet-apply` (submit), `search-results`, `search-result` (per card), `search-results-count` |
| listing (`/listing/[id]`) | `listing-title`, `listing-price`, `attribute-table`, `listing-card`, `listing-rfq-cta` (→ `/rfq/[id]`) |
| RFQ (`/rfq/[listingId]`) | `rfq-form`, `rfq-field-<key>` per `vertical.rfqFields[].key` (buyer email is `rfq-field-email`), `rfq-honeypot`, `rfq-submit`, `rfq-error` |
| RFQ thanks (`/rfq/thanks`) | `rfq-confirmation`, `rfq-reference` (rfqId), `rfq-view-quotes` |
| misc | `design-gallery` (`/design`), `legal-imprint`, `legal-privacy`, `legal-tos` |

## 🔲 Small additions to merged pages

- `signin-role-buyer`, `signin-role-operator` on the role radios (`/sign-in`).
  Specs fall back to `getByRole('radio', { name: /operator/i })` until then.
- `plan-limit-banner` on `/app/listings/new` when the plan limit is hit
  (currently the 402 error + `upgrade-cta` plays this role — spec accepts both).

## Env/seed contract the suite assumes

- `POST /api/auth/magic-link {email, role}` → `{ devLink }` (mock mode); emailed
  link goes to `tmp/outbox/*.json` (`{to, subject, body}`) or Mailpit when
  `EMAIL_PROVIDER=smtp` (`MAILPIT_API_URL` — helper tries both).
- `GET /api/auth/callback?token=` sets `jm_session` cookie.
- `admin@jetmarket.local` resolves to admin via `ADMIN_EMAILS` (default list).
- `GET /api/health` → `{ ok: true, vertical }`.
- E2E env vars: `E2E_BASE_URL` (skip webServer boot, test a deploy),
  `E2E_PORT` (default 3000), `TEST_DATABASE_URL` (default
  `<DATABASE_URL host>/jetmarket_test`), `VERTICAL` (default `jets`,
  `machinery` for the second spec), `E2E_REQUIRE_DB=1` forces test-DB
  provisioning even while the repo is in-memory.

## Promoting pending specs

`pending/` holds specs written before their pages exist (excluded from
`playwright test` and CI). When the dependencies land, move the file to `e2e/`:

```bash
git mv tests-e2e/pending/<spec>.spec.ts tests-e2e/e2e/
```

Status: `core-loop.ui.spec.ts` promoted after W3's public slice merged.
`machinery.spec.ts` promoted after T16 — runs in the env-gated `machinery`
project: `pnpm --filter @jetmarket/tests-e2e test:e2e:machinery`.

## Running machinery e2e

```bash
pnpm --filter @jetmarket/tests-e2e test:e2e:machinery
```

Boots the webServer with `VERTICAL=machinery` (inherited env) on the shared
`jetmarket_test` DB — rows are isolated by the `vertical` column. The spec
self-skips under any other vertical; run it sequentially after (not
concurrently with) `test:e2e` — both share `apps/web/.next`.
