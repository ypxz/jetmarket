// QA-481/482: buyer amends an RFQ inline on /quotes — the Edit button opens
// the field-def-driven form, Save PATCHes in place, and the echo line
// reflects the new details after reload. (API-level coverage lives in
// buyer-amend.api.spec.ts — this spec owns the UI path end-to-end.)
import { expect, test } from '@playwright/test';
import {
  createListing,
  createOperatorProfile,
  fillRfqForm,
  signUpAndLogin,
  step,
  tidPrefix,
} from '../helpers/flow';

// Isolated rate-limit bucket per spec file — the dev server keeps buckets
// across suite runs, so shared IPs exhaust ml:*/30ph mid-suite (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.17.3' } });

const run = Date.now().toString(36);
const OPERATOR_EMAIL = `e2e-ui-amend-ops-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-ui-amend-buyer-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E UI Amend Charter ${run}`;

test('buyer edits a live RFQ on /quotes: form prefills, echo updates', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const operator = await browser.newPage();
  const buyer = await browser.newPage();

  await step('operator signs up and lists a charter', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E Amend Ops ${run}`,
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

  await step('buyer opens the inline edit form and changes departure', async () => {
    await buyer.getByTestId('rfq-view-quotes').click();
    const emailInput = buyer.getByTestId('buyer-email');
    if (!(await emailInput.inputValue())) await emailInput.fill(BUYER_EMAIL);
    await buyer.getByTestId('buyer-load').click();

    const rfq = buyer.locator(tidPrefix('buyer-rfq-')).first();
    await expect(rfq).toBeVisible();
    // fillRfqForm wrote 'e2e' into the text fields — the echo shows it.
    await expect(rfq.locator(tidPrefix('rfq-echo-'))).toContainText('e2e');

    await rfq.locator(tidPrefix('edit-rfq-')).click();
    const form = rfq.locator(tidPrefix('rfq-edit-form-'));
    await expect(form).toBeVisible();
    // The form prefills from the stored field map — swap the departure.
    const departureInput = rfq.locator('input[data-testid*="-departure"]');
    await expect(departureInput).toHaveValue('e2e');
    await departureInput.fill('GVA');
    await rfq.locator(tidPrefix('rfq-edit-save-')).click();

    // Amended message + the echo line now carries the new departure.
    await expect(buyer.getByTestId('accept-msg')).toContainText(/updated/i);
    await expect(rfq.locator(tidPrefix('rfq-echo-'))).toContainText('GVA');
    await expect(rfq.locator(tidPrefix('rfq-edit-form-'))).toHaveCount(0);
  });

  await step('the amendment survives a reload', async () => {
    await buyer.reload();
    const rfq = buyer.locator(tidPrefix('buyer-rfq-')).first();
    await expect(rfq.locator(tidPrefix('rfq-echo-'))).toContainText('GVA');
  });
});
