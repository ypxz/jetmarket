// QA-511 buyer counter-offer: the buyer names their price on a live
// quote — the operator sees the "Countered" chip + mail and answers by
// revising, which clears the round and lets the buyer accept.
import { expect, test } from '@playwright/test';
import {
  createListing,
  createOperatorProfile,
  fillRfqForm,
  signUpAndLogin,
  step,
  tidPrefix,
} from '../helpers/flow';

// Isolated rate-limit bucket per spec file (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.15.9' } });

const run = Date.now().toString(36);
const OPERATOR_EMAIL = `e2e-ui-counter-ops-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-ui-counter-buyer-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E UI Counter Charter ${run}`;

test('buyer counters a quote; operator revises; buyer accepts', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const operator = await browser.newPage();
  const buyer = await browser.newPage();

  await step('operator signs up and lists a charter', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E Counter Ops ${run}`,
      baseAirport: 'LSZH',
    });
    await createListing(operator, {
      type: 'charter',
      title: LISTING_TITLE,
      price: '12000',
      fields: { aircraftCategory: 'mid', model: 'PC-24', seats: '8', year: '2021', baseAirport: 'ZRH' },
    });
    await expect(operator).toHaveURL(/\/app/);
  });

  await step('buyer sends an RFQ on the listing', async () => {
    await buyer.goto('/search');
    await buyer.getByTestId('facet-q').fill(LISTING_TITLE);
    await buyer.getByTestId('facet-apply').click();
    await buyer
      .getByTestId('search-result')
      .filter({ hasText: LISTING_TITLE })
      .first()
      .click();
    await buyer.getByTestId('listing-rfq-cta').click();
    await buyer.waitForURL(/\/rfq\//, { timeout: 15_000 }).catch(async () => {
      await buyer.getByTestId('listing-rfq-cta').click();
      await buyer.waitForURL(/\/rfq\//, { timeout: 15_000 });
    });
    await fillRfqForm(buyer, BUYER_EMAIL);
    await buyer.getByTestId('rfq-submit').click();
    await buyer.waitForURL(/\/rfq\/thanks/, { timeout: 15_000 });
    await expect(buyer.getByTestId('rfq-confirmation')).toBeVisible({
      timeout: 10_000,
    });
  });

  await step('operator quotes the RFQ', async () => {
    await operator.goto('/app/rfqs');
    const item = operator.locator('li[data-testid^="rfq-"]').filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    await item.locator(tidPrefix('quote-amount-')).fill('11000');
    const sendResp = operator.waitForResponse(
      (r) =>
        r.url().includes('/api/quotes') &&
        r.request().method() === 'POST' &&
        r.status() === 201,
    );
    await item.locator(tidPrefix('quote-send-')).click();
    await sendResp;
    await expect(item).toContainText(/quote sent|sent/i);
  });

  await step('buyer counters under the ask', async () => {
    await buyer.getByTestId('rfq-view-quotes').click();
    const emailInput = buyer.getByTestId('buyer-email');
    if (!(await emailInput.inputValue())) await emailInput.fill(BUYER_EMAIL);
    const loadResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/api/buyer/quotes') &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
    await buyer.getByTestId('buyer-load').click();
    await loadResp;
    const quote = buyer.locator(tidPrefix('quote-')).first();
    await expect(quote).toBeVisible();
    const resp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/counter') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await quote.locator(tidPrefix('counter-')).first().click();
    await buyer.locator(tidPrefix('counter-amount-')).fill('9500');
    await buyer.locator(tidPrefix('counter-send-')).click();
    expect((await resp).status()).toBe(200);
    await expect(buyer.getByTestId('accept-msg')).toContainText(
      /counter/i,
    );
    // After reload the card chips the live counter and the Counter
    // button retires — one counter per offer round.
    await expect(quote.locator(tidPrefix('counter-sent-'))).toBeVisible();
    await expect(quote.locator(tidPrefix('counter-amount-'))).toHaveCount(0);
  });

  await step('operator inbox chips the counter', async () => {
    await operator.goto('/app/rfqs');
    const chip = operator.locator('[data-testid^="quote-counter-"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(/counter/i);
    await expect(chip).toContainText('9,500');
    // The dashboard's open-offers row carries the same signal — the op
    // sees a countered offer wherever they look.
    await operator.goto('/app');
    await expect(
      operator.locator('[data-testid^="offer-counter-"]'),
    ).toBeVisible();
  });

  await step('the Countered inbox filter isolates the hot lead (QA-513)', async () => {
    await operator.goto('/app/rfqs');
    await operator.getByTestId('filter-countered').click();
    await expect(operator).toHaveURL(/f=countered/);
    // The countered RFQ is the whole view — nothing else qualifies.
    const rows = operator.locator('li[data-testid^="rfq-"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(LISTING_TITLE);
    // The plain inbox keeps it too (a counter doesn't move the row).
    await operator.getByTestId('filter-all').click();
    await expect(
      operator.locator('li[data-testid^="rfq-"]').filter({ hasText: LISTING_TITLE }),
    ).toBeVisible();
  });

  await step('operator meets it with a revise — the round clears', async () => {
    await operator.goto('/app/rfqs');
    const item = operator.locator('li[data-testid^="rfq-"]').filter({ hasText: LISTING_TITLE });
    // 'revise-' also prefixes the inner form inputs — pin the button.
    await item.locator(`button${tidPrefix('revise-')}`).first().click();
    await item.locator(tidPrefix('revise-amount-')).fill('10000');
    const resp = operator.waitForResponse(
      (r) =>
        r.url().includes('/revise') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await item.locator(tidPrefix('revise-save-')).click();
    await resp;
    // The counter chip is gone — the revise answered it.
    await expect(
      item.locator('[data-testid^="quote-counter-"]'),
    ).toHaveCount(0);

    // Buyer reloads: counter chip cleared, revised offer still
    // acceptable — the negotiation round trip closes.
    const loadResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/api/buyer/quotes') &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
    await buyer.reload();
    await loadResp;
    const live = buyer.locator(tidPrefix('quote-')).filter({
      has: buyer.locator(tidPrefix('accept-')),
    });
    await expect(live).toHaveCount(1);
    await expect(live.locator(tidPrefix('counter-sent-'))).toHaveCount(0);
    const acceptResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/accept') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await live.locator(tidPrefix('accept-')).click();
    await acceptResp;
    await expect(buyer.getByTestId('accept-msg')).toContainText(/accepted/i);
  });
});
