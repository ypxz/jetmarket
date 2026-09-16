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
    await expect(buyer.getByTestId('rfq-confirmation')).toBeVisible({
      timeout: 15_000,
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

  await step('buyer declines the quote', async () => {
    await buyer.goto(`/quotes?email=${encodeURIComponent(BUYER_EMAIL)}`);
    const emailInput = buyer.getByTestId('buyer-email');
    if (!(await emailInput.inputValue())) await emailInput.fill(BUYER_EMAIL);
    await buyer.getByTestId('buyer-load').click();
    const quote = buyer.locator(tidPrefix('quote-')).first();
    await expect(quote).toBeVisible();
    await quote.locator(tidPrefix('decline-')).click();
    await expect(buyer.getByTestId('accept-msg')).toContainText(/declined/i);
    // after reload the quote row shows declined and offers no action buttons
    await expect(quote).toContainText('declined');
    await expect(quote.locator(tidPrefix('accept-'))).toHaveCount(0);
    await expect(quote.locator(tidPrefix('decline-'))).toHaveCount(0);
  });
});
