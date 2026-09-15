// Second acceptance loop (spec §Acceptance): boot with VERTICAL=machinery —
// placeholder taxonomy (listing types for_sale/for_rent/auction), same flow.
// Run:  VERTICAL=machinery pnpm --filter @jetmarket/tests-e2e test:pending
// Depends on T16 (machinery boot) AND W3's public pages — stays pending until
// both land.
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
const OPERATOR_EMAIL = `e2e-mach-ops-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-mach-buyer-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E Machine ${run}`;
const QUOTE_AMOUNT = '12000';

test('machinery vertical: placeholder taxonomy boots and the core loop passes', async ({
  browser,
}) => {
  test.skip(process.env.VERTICAL !== 'machinery', 'run with VERTICAL=machinery');

  const operator = await browser.newPage();
  const buyer = await browser.newPage();

  await step('operator signs up and creates a listing', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E Machinery Ops ${run}`,
      baseAirport: 'ZRH',
    });
    await createListing(operator, {
      type: 'for_sale', // first placeholder listing type (verticals/machinery)
      title: LISTING_TITLE,
      price: '15000',
    });
  });

  await step('buyer finds it and sends an RFQ', async () => {
    await buyer.goto('/search');
    await buyer.getByTestId('search-input').fill(LISTING_TITLE);
    await buyer.getByTestId('search-submit').click();
    await buyer.getByTestId('search-result-item').filter({ hasText: LISTING_TITLE }).click();
    await expect(buyer.getByTestId('listing-detail')).toBeVisible();
    await buyer.getByTestId('rfq-open-button').click();
    // rfq fields come from the vertical config — generic contract rfq-field-<key>
    await buyer.getByTestId('rfq-field-email').fill(BUYER_EMAIL);
    await buyer.getByTestId('rfq-submit').click();
    await expect(buyer.getByTestId('rfq-success')).toBeVisible();
  });

  await step('operator quotes and buyer accepts', async () => {
    await operator.goto('/app/rfqs');
    const item = operator.locator(tidPrefix('rfq-')).filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    await item.locator(tidPrefix('quote-amount-')).fill(QUOTE_AMOUNT);
    await item.locator(tidPrefix('quote-send-')).click();
    await buyer.goto(`/quotes?email=${encodeURIComponent(BUYER_EMAIL)}`);
    const quote = buyer.locator(tidPrefix('quote-')).filter({ hasText: QUOTE_AMOUNT });
    await expect(quote).toBeVisible();
    await quote.locator(tidPrefix('accept-')).click();
    await expect(buyer.getByTestId('accept-msg')).toContainText(/deal|closed/i);
  });
});
