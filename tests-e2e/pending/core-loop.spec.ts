// Core acceptance loop at UI level (spec §Acceptance), browser twin of
// e2e/core-loop.api.spec.ts. Written against the data-testid contract in
// TESTIDS.md — PENDING until W3's public pages (/search, /listing/[id], /rfq)
// land. Promote with `git mv pending/core-loop.spec.ts e2e/`.
import { expect, test } from '@playwright/test';
import {
  createListing,
  createOperatorProfile,
  signUpAndLogin,
  step,
  tid,
  tidPrefix,
} from '../helpers/flow';

const run = Date.now();
const OPERATOR_EMAIL = `e2e-ui-operator-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-ui-buyer-${run}@jetmarket.local`;
const ADMIN_EMAIL = 'admin@jetmarket.local';
const LISTING_TITLE = `E2E UI Charter ${run}`;
const QUOTE_AMOUNT = '42000';
// 3% success fee on charters → 1,260 rendered in the ledger
const EXPECTED_FEE = '1,260';

test('core loop UI: signup → listings → search → RFQ → quote → accept → admin → upgrade', async ({
  browser,
}) => {
  const operator = await browser.newPage();
  const buyer = await browser.newPage();
  const admin = await browser.newPage();

  await step('operator signs up via mock magic link', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E UI Ops ${run}`,
      baseAirport: 'LSZH',
    });
  });

  await step('operator creates 2 listings', async () => {
    await createListing(operator, {
      type: 'charter',
      title: LISTING_TITLE,
      price: '38000',
      fields: { category: 'light', model: 'Phenom 300', seats: '7' },
    });
    await expect(operator).toHaveURL(/\/app/);
    await createListing(operator, {
      type: 'empty_leg',
      title: `E2E UI Empty Leg ${run}`,
      price: '9500',
      fields: { category: 'mid', model: 'Citation XLS', seats: '8', from: 'ZRH', to: 'NCE', date: '2026-10-01' },
    });
    await expect(operator).toHaveURL(/\/app/);
  });

  await step('buyer searches with facets and sends RFQ', async () => {
    // /search, /listing/[id], /rfq are W3's — testids per TESTIDS.md
    await buyer.goto('/search');
    await buyer.getByTestId('search-input').fill(LISTING_TITLE);
    await buyer.getByTestId('search-submit').click();
    await buyer.getByTestId('facet-type-option-charter').click();
    await expect(buyer.locator(tid('search-results'))).toContainText(LISTING_TITLE);
    await buyer.getByTestId('search-result-item').filter({ hasText: LISTING_TITLE }).click();
    await expect(buyer.getByTestId('listing-detail')).toBeVisible();

    await buyer.getByTestId('rfq-open-button').click();
    await buyer.getByTestId('rfq-field-route').fill('ZRH-NCE');
    await buyer.getByTestId('rfq-field-pax').fill('4');
    await buyer.getByTestId('rfq-field-budget').fill('45000');
    await buyer.getByTestId('rfq-field-email').fill(BUYER_EMAIL);
    await buyer.getByTestId('rfq-submit').click();
    await expect(buyer.getByTestId('rfq-success')).toBeVisible();
  });

  await step('operator quotes the RFQ from the inbox', async () => {
    await operator.goto('/app/rfqs');
    const item = operator.locator(tidPrefix('rfq-')).filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    await item.locator(tidPrefix('quote-amount-')).fill(QUOTE_AMOUNT);
    await item.locator(tidPrefix('quote-send-')).click();
    await expect(item).toContainText('Quote sent');
  });

  await step('buyer accepts the quote', async () => {
    await buyer.goto(`/quotes?email=${encodeURIComponent(BUYER_EMAIL)}`);
    const quote = buyer.locator(tidPrefix('quote-')).filter({ hasText: QUOTE_AMOUNT });
    await expect(quote).toBeVisible();
    await quote.locator(tidPrefix('accept-')).click();
    await expect(buyer.getByTestId('accept-msg')).toContainText(/deal|closed/i);
  });

  await step('admin fee ledger shows the deal and fee invoice', async () => {
    await signUpAndLogin(admin, ADMIN_EMAIL);
    await admin.goto('/admin');
    const ledger = admin.getByTestId('fee-ledger');
    await expect(ledger).toBeVisible();
    await expect(ledger.locator(tidPrefix('deal-')).filter({ hasText: EXPECTED_FEE })).toBeVisible();
  });

  await step('free limit → upgrade via mock checkout → limit lifted', async () => {
    // third listing still allowed (free = 3)
    await createListing(operator, {
      type: 'charter',
      title: `E2E UI Third ${run}`,
      price: '30000',
      fields: { category: 'mid', model: 'G280', seats: '9' },
    });
    // fourth is rejected: 402 surfaces the upgrade CTA on the form
    await createListing(operator, {
      type: 'charter',
      title: `E2E UI Fourth ${run}`,
      price: '31000',
      fields: { category: 'mid', model: 'G280', seats: '9' },
    });
    await expect(operator.getByTestId('upgrade-cta')).toBeVisible();

    await operator.getByTestId('upgrade-cta').click();
    await operator.getByTestId('checkout-pro').click();
    await expect(operator.getByTestId('pro-active')).toBeVisible();

    await createListing(operator, {
      type: 'charter',
      title: `E2E UI Post-Upgrade ${run}`,
      price: '31000',
      fields: { category: 'mid', model: 'G280', seats: '9' },
    });
    await expect(operator).toHaveURL(/\/app/);
  });
});
