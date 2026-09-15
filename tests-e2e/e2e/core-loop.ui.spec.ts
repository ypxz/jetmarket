// Core acceptance loop at UI level (spec §Acceptance), browser twin of
// e2e/core-loop.api.spec.ts. Runs against the data-testid hooks shipped by
// W3's public slice — see tests-e2e/TESTIDS.md for the contract.
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
// Unique per run — the shared dev repo accumulates deals across runs, so a
// fixed amount would collide with leftover ledger rows.
const QUOTE_AMOUNT = String(40000 + (run % 50000));
const QUOTE_AMOUNT_FMT = Number(QUOTE_AMOUNT).toLocaleString('en-US');
// 3% success fee on charters; the ledger renders whole dollars (formatMoney).
const EXPECTED_FEE = Math.round(Number(QUOTE_AMOUNT) * 0.03).toLocaleString('en-US');

test('core loop UI: signup → listings → search → RFQ → quote → accept → admin → upgrade', async ({
  browser,
}) => {
  test.setTimeout(300_000); // multi-actor flow on cold `next dev` compiles
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
      fields: { aircraftCategory: 'light', model: 'Phenom 300', seats: '7' },
    });
    await expect(operator).toHaveURL(/\/app/);
    await createListing(operator, {
      type: 'empty_leg',
      title: `E2E UI Empty Leg ${run}`,
      price: '9500',
      fields: { aircraftCategory: 'mid', model: 'Citation XLS', seats: '8', from: 'ZRH', to: 'NCE', date: '2026-10-01' },
    });
    await expect(operator).toHaveURL(/\/app/);
  });

  await step('buyer searches with facets and sends RFQ', async () => {
    await buyer.goto('/search');
    await buyer.getByTestId('facet-q').fill(LISTING_TITLE);
    await buyer.getByTestId('facet-type').selectOption('charter');
    await buyer.getByTestId('facet-apply').click();
    await expect(buyer.locator(tid('search-results'))).toContainText(LISTING_TITLE);
    await buyer
      .getByTestId('search-result')
      .filter({ hasText: LISTING_TITLE })
      .first()
      .click();
    await expect(buyer).toHaveURL(/\/listing\//);
    await expect(buyer.getByTestId('listing-title')).toContainText(LISTING_TITLE);

    await buyer.getByTestId('listing-rfq-cta').click();
    // `next dev` can bounce client navigation while the rfq route is compiling;
    // retry the click once rather than flake on cold-compile timing.
    await buyer.waitForURL(/\/rfq\//, { timeout: 15_000 }).catch(async () => {
      await buyer.getByTestId('listing-rfq-cta').click();
      await buyer.waitForURL(/\/rfq\//, { timeout: 15_000 });
    });
    await buyer.getByTestId('rfq-field-departure').fill('ZRH');
    await buyer.getByTestId('rfq-field-arrival').fill('NCE');
    await buyer.getByTestId('rfq-field-dateFrom').fill('2026-10-01');
    await buyer.getByTestId('rfq-field-dateTo').fill('2026-10-02');
    await buyer.getByTestId('rfq-field-passengers').fill('4');
    await buyer.getByTestId('rfq-field-budgetUsd').fill('45000');
    await buyer.getByTestId('rfq-field-name').fill('E2E Buyer');
    await buyer.getByTestId('rfq-field-email').fill(BUYER_EMAIL);
    await buyer.getByTestId('rfq-submit').click();
    await expect(buyer.getByTestId('rfq-confirmation')).toBeVisible();
    await expect(buyer.getByTestId('rfq-reference')).toBeVisible();
  });

  await step('operator quotes the RFQ from the inbox', async () => {
    await operator.goto('/app/rfqs');
    const item = operator.locator(tidPrefix('rfq-')).filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    await item.locator(tidPrefix('quote-amount-')).fill(QUOTE_AMOUNT);
    await item.locator(tidPrefix('quote-send-')).click();
    await expect(item).toContainText(/quote sent|sent/i);
  });

  await step('buyer accepts the quote', async () => {
    await buyer.goto(`/quotes?email=${encodeURIComponent(BUYER_EMAIL)}`);
    const emailInput = buyer.getByTestId('buyer-email');
    if (!(await emailInput.inputValue())) await emailInput.fill(BUYER_EMAIL);
    await buyer.getByTestId('buyer-load').click();
    // amount renders grouped, e.g. "USD 41,000"
    const quote = buyer
      .locator(tidPrefix('quote-'))
      .filter({ hasText: QUOTE_AMOUNT_FMT });
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
      fields: { aircraftCategory: 'mid', model: 'G280', seats: '9' },
    });
    // fourth is rejected: 402 surfaces the upgrade CTA on the form
    await createListing(operator, {
      type: 'charter',
      title: `E2E UI Fourth ${run}`,
      price: '31000',
      fields: { aircraftCategory: 'mid', model: 'G280', seats: '9' },
    });
    await expect(operator.getByTestId('upgrade-cta')).toBeVisible();

    await operator.getByTestId('upgrade-cta').click();
    await operator.getByTestId('checkout-pro').click();
    await expect(operator.getByTestId('pro-active')).toBeVisible();

    await createListing(operator, {
      type: 'charter',
      title: `E2E UI Post-Upgrade ${run}`,
      price: '31000',
      fields: { aircraftCategory: 'mid', model: 'G280', seats: '9' },
    });
    await expect(operator).toHaveURL(/\/app/);
  });
});
