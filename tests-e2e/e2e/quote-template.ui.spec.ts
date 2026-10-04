// QA-527: operator quote templates — the op fills the inbox quote form,
// saves it as a named preset, and on the next RFQ picks it from the
// picker to refill amount+message in one click before sending.
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
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.18.4' } });

const run = Date.now().toString(36);
const OPERATOR_EMAIL = `e2e-ui-tpl-ops-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-ui-tpl-buyer-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E UI Tpl Charter ${run}`;

test('operator saves a quote template and applies it to the next RFQ', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const operator = await browser.newPage();
  const buyer = await browser.newPage();

  await step('operator signs up and lists a charter', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E Tpl Ops ${run}`,
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
  });

  await step('operator fills the quote form and saves it as a template', async () => {
    await operator.goto('/app/rfqs');
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    // No templates yet — the picker stays hidden until the first save.
    await expect(
      item.locator('select[data-testid^="quote-template-pick-"]'),
    ).toHaveCount(0);
    await item.locator(tidPrefix('quote-amount-')).fill('11500');
    await item.locator('input[name="message"]').fill('includes repositioning');
    // Warm the route — `next dev` drops the body of the first request it
    // compiles on demand (QA-524 AGENTS note); the mounted fetch is a GET
    // already, this pins it before the POST.
    await operator.request.get('/api/operator/quote-templates');
    const save = operator.waitForResponse(
      (r) =>
        r.url().includes('/api/operator/quote-templates') &&
        r.request().method() === 'POST' &&
        r.status() === 201,
    );
    await item.locator(tidPrefix('quote-template-name-')).fill('Standard');
    await item.locator(tidPrefix('quote-template-save-')).click();
    await save;
    // Picker now renders with the saved preset.
    const picker = item.locator(
      'select[data-testid^="quote-template-pick-"]',
    );
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('Standard');
  });

  await step('template survives reload and refills the form', async () => {
    await operator.goto('/app/rfqs');
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    const picker = item.locator(
      'select[data-testid^="quote-template-pick-"]',
    );
    await expect(picker).toBeVisible();
    await picker.selectOption({ label: 'Standard' });
    await expect(item.locator(tidPrefix('quote-amount-'))).toHaveValue(
      '11500',
    );
    await expect(item.locator('input[name="message"]')).toHaveValue(
      'includes repositioning',
    );
    const sendResp = operator.waitForResponse(
      (r) =>
        r.url().includes('/api/quotes') &&
        r.request().method() === 'POST' &&
        r.status() === 201,
    );
    await item.locator(tidPrefix('quote-send-')).click();
    await sendResp;
    await expect(item).toContainText(/sent/i);
  });
});
