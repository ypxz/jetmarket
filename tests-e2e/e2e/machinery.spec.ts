// Second acceptance loop (spec §Acceptance): boot with VERTICAL=machinery —
// placeholder taxonomy (listing types for_sale/for_rent/auction), same flow.
// Runs in the `machinery` project only: `pnpm --filter @jetmarket/tests-e2e
// test:e2e:machinery` (sets VERTICAL=machinery; the webServer inherits it).
// Known gap (QA-15): the /app/listings/new form is jets-hardcoded — machinery
// listings are created via the API here until a per-vertical form lands.
import { expect, test } from '@playwright/test';
import {
  createOperatorProfile,
  fillRfqForm,
  signUpAndLogin,
  step,
  tidPrefix,
} from '../helpers/flow';

const run = Date.now();
const OPERATOR_EMAIL = `e2e-mach-ops-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-mach-buyer-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E Machine ${run}`;
const EXPECTED_QUOTE = '12,000';

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
    // UI listing form is jets-shaped (QA-15) — create via the API, which
    // validates attributes against the machinery vertical schema.
    const res = await operator.request.post('/api/listings', {
      data: {
        type: 'for_sale',
        title: LISTING_TITLE,
        price: 15000,
        currency: 'EUR',
        photos: [],
        attributes: {
          machineryCategory: 'forklift',
          make: 'Toyota 8FB',
          yearOfManufacture: 2019,
          hoursUsed: 1200,
          weightKg: 4150,
          locationCountry: 'DE',
        },
      },
    });
    expect(res.status(), await res.text()).toBe(201);
  });

  await step('buyer finds it and sends an RFQ', async () => {
    await buyer.goto('/search');
    await buyer.getByTestId('facet-q').fill(LISTING_TITLE);
    await buyer.getByTestId('facet-apply').click();
    await buyer
      .getByTestId('search-result')
      .filter({ hasText: LISTING_TITLE })
      .first()
      .click();
    await expect(buyer).toHaveURL(/\/listing\//);
    await buyer.getByTestId('listing-rfq-cta').click();
    // rfq fields come from the vertical config — fill them generically
    await fillRfqForm(buyer, BUYER_EMAIL);
    await buyer.getByTestId('rfq-submit').click();
    await expect(buyer.getByTestId('rfq-confirmation')).toBeVisible();
  });

  await step('operator quotes and buyer accepts', async () => {
    await operator.goto('/app/rfqs');
    const item = operator.locator(tidPrefix('rfq-')).filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    await item.locator(tidPrefix('quote-amount-')).fill('12000');
    await item.locator(tidPrefix('quote-send-')).click();
    await buyer.goto(`/quotes?email=${encodeURIComponent(BUYER_EMAIL)}`);
    const load = buyer.getByTestId('buyer-load');
    if (await load.count()) {
      if (!(await buyer.getByTestId('buyer-email').inputValue()))
        await buyer.getByTestId('buyer-email').fill(BUYER_EMAIL);
      await load.click();
    }
    const quote = buyer.locator(tidPrefix('quote-')).filter({ hasText: EXPECTED_QUOTE });
    await expect(quote).toBeVisible();
    await quote.locator(tidPrefix('accept-')).click();
    await expect(buyer.getByTestId('accept-msg')).toContainText(/deal|closed/i);
  });
});
