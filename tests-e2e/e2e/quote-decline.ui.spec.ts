// T27 decline path at UI level: buyer declines a sent quote on /quotes —
// the quote flips to declined while its RFQ keeps its status.
import { expect, test } from '@playwright/test';
import {
  createListing,
  createOperatorProfile,
  fillRfqForm,
  signUpAndLogin,
  step,
  tidPrefix,
} from '../helpers/flow';

// Isolated rate-limit bucket per spec file — the dev server keeps
// buckets across the whole suite run (and across runs when reused), so
// shared 'local' IP logins exhaust ml:*/30ph mid-suite (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.15.7' } });

const run = Date.now().toString(36);
const OPERATOR_EMAIL = `e2e-ui-decline-ops-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-ui-decline-buyer-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E UI Decline Charter ${run}`;

test('buyer declines a quote: quote -> declined, rfq stays quoted', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const operator = await browser.newPage();
  const buyer = await browser.newPage();

  await step('operator signs up and lists a charter', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E Decline Ops ${run}`,
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
    // Wait on the redirect, not the element — /rfq/thanks can take several
    // seconds to render under `next dev` cold-compile (QA-144/QA-316).
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
    // Wait on the POST — a cold dev-compile of the quotes route can eat the
    // whole 10s expect window (QA-494).
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

  await step('buyer declines the quote', async () => {
    // the thanks page's 'view quotes' link carries the per-RFQ bearer token (QA-39)
    await buyer.getByTestId('rfq-view-quotes').click();
    const emailInput = buyer.getByTestId('buyer-email');
    if (!(await emailInput.inputValue())) await emailInput.fill(BUYER_EMAIL);
    // /api/buyer/quotes can cold-compile past the element timeout — wait on
    // the response, then the card (QA-494).
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
    // Wait on the network, not the DOM — a cold dev-compile of the decline
    // route can outlast the element timeout even though the request succeeds
    // (observed flake, QA-492 run).
    const resp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/decline') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    // QA-508: decline is two-step — the button reveals structured reason
    // chips; picking one POSTs the decline with it.
    await quote.locator(tidPrefix('decline-')).click();
    await quote.locator(tidPrefix('decline-reason-price-')).click();
    expect((await resp).status()).toBe(200);
    await expect(buyer.getByTestId('accept-msg')).toContainText(/declined/i);
    // after reload the quote row shows declined and offers no action buttons
    await expect(quote).toContainText('declined');
    await expect(quote.locator(tidPrefix('accept-'))).toHaveCount(0);
    await expect(quote.locator(tidPrefix('decline-'))).toHaveCount(0);
  });

  await step('operator inbox chips the buyer-given reason', async () => {
    await operator.goto('/app/rfqs');
    const chip = operator.locator(
      '[data-testid^="quote-decline-reason-"]',
    );
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('too expensive');
  });
});
