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
| buyer quotes (`/quotes`) | `buyer-email`, `buyer-load`, `buyer-rfq-<id>`, `quote-<id>`, `accept-<id>`, `accept-msg` |
| admin (`/admin`) | `fee-ledger`, `deal-<id>`, `admin-op-<id>`, `admin-verified-<id>`, `verify-<operatorId>` |
| billing | `checkout-pro`, `pro-active`, `upgrade-cta` |

## 🔲 Needed from W3 public pages (`/search`, `/listing/[id]`, `/rfq`)

| testid | Where | Notes |
|---|---|---|
| `search-input`, `search-submit` | `/search` | text search over listings |
| `search-results` | `/search` | results container |
| `search-result-item` | `/search` | one per result, clickable → listing page |
| `facets` | `/search` | facet sidebar container |
| `facet-<key>` | `/search` | facet group per `vertical.facets[].key` (e.g. `facet-type`) |
| `facet-<key>-option-<value>` | `/search` | option control per facet value (e.g. `facet-type-option-charter`) |
| `listing-detail` | `/listing/[id]` | detail page root |
| `rfq-open-button` | `/listing/[id]` | opens/scrolls to RFQ form |
| `rfq-form` | RFQ form | form element |
| `rfq-field-<key>` | RFQ form | one control per `vertical.rfqFields[].key`; buyer email field is `rfq-field-email` |
| `rfq-submit` | RFQ form | submit button |
| `rfq-success` | RFQ form | success state after submit |

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
`playwright test` and CI). When the testids above land:

```bash
git mv tests-e2e/pending/core-loop.spec.ts tests-e2e/e2e/
pnpm test:e2e
```
