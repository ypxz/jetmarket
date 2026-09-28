// QA-194: buyer close-request at UI level — on /quotes the buyer ends an
// in-flight RFQ; the RFQ flips to closed and its sent quotes decline.
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
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.16.7' } });

const run = Date.now().toString(36);
const OPERATOR_EMAIL = `e2e-ui-close-ops-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-ui-close-buyer-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E UI Close Charter ${run}`;

test('buyer closes an RFQ: rfq -> closed, pending quote declines', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const operator = await browser.newPage();
  const buyer = await browser.newPage();

  await step('operator signs up and lists a charter', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E Close Ops ${run}`,
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
    const item = operator.locator(tidPrefix('rfq-')).filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    await item.locator(tidPrefix('quote-amount-')).fill('11000');
    await item.locator(tidPrefix('quote-send-')).click();
    await expect(item).toContainText(/quote sent|sent/i);
  });

  await step('buyer closes the request', async () => {
    // the thanks page's 'view quotes' link carries the per-RFQ bearer token (QA-39)
    await buyer.getByTestId('rfq-view-quotes').click();
    const emailInput = buyer.getByTestId('buyer-email');
    if (!(await emailInput.inputValue())) await emailInput.fill(BUYER_EMAIL);
    await buyer.getByTestId('buyer-load').click();

    const rfq = buyer.locator(tidPrefix('buyer-rfq-')).first();
    await expect(rfq).toBeVisible();
    await rfq.locator(tidPrefix('close-rfq-')).click();
    await expect(buyer.getByTestId('accept-msg')).toContainText(/closed/i);

    // after reload: status closed, no close button, quote shows declined
    await expect(rfq).toContainText('closed');
    await expect(rfq.locator(tidPrefix('close-rfq-'))).toHaveCount(0);
    const quote = rfq.locator(tidPrefix('quote-')).first();
    await expect(quote).toContainText('declined');
    await expect(quote.locator(tidPrefix('accept-'))).toHaveCount(0);
  });
});
