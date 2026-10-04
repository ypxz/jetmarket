// QA-533: buyer pause/resume at UI level — pausing freezes NEW offer intake
// (op inbox hides the form, POST /api/quotes 409s) while the row stays live;
// resuming re-opens it and the operator quotes normally.
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
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.25.7' } });

const run = Date.now().toString(36);
const OPERATOR_EMAIL = `e2e-ui-pause-ops-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-ui-pause-buyer-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E UI Pause Charter ${run}`;

test('buyer pauses an RFQ: op intake freezes, resume re-opens it', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const operator = await browser.newPage();
  const buyer = await browser.newPage();

  await step('operator signs up and lists a charter', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E Pause Ops ${run}`,
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

  await step('buyer pauses the request from the inbox', async () => {
    await buyer.getByTestId('rfq-view-quotes').click();
    const emailInput = buyer.getByTestId('buyer-email');
    if (!(await emailInput.inputValue())) await emailInput.fill(BUYER_EMAIL);
    await buyer.getByTestId('buyer-load').click();

    const rfq = buyer.locator(tidPrefix('buyer-rfq-')).first();
    await expect(rfq).toBeVisible();
    // Wait on the network, not the DOM — a cold dev-compile of the pause
    // route can eat the expect window (QA-493 lesson).
    const pauseResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/pause') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await rfq.locator(tidPrefix('pause-rfq-')).click();
    await pauseResp;
    await expect(
      rfq.locator(tidPrefix('rfq-paused-')),
    ).toBeVisible({ timeout: 10_000 });
  });

  await step('the operator inbox freezes new-offer intake', async () => {
    await operator.goto('/app/rfqs');
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    await expect(
      item.locator(tidPrefix('rfq-paused-')),
    ).toBeVisible();
    // The form is gone — a submit attempt can't even render.
    await expect(item.locator(tidPrefix('quote-send-'))).toHaveCount(0);
    await expect(
      item.locator(tidPrefix('rfq-intake-paused-')),
    ).toBeVisible();
    // And the route itself still refuses — the badge isn't the only gate.
    const rfqId = (await item.getAttribute('data-testid'))!.replace(
      'rfq-',
      '',
    );
    const res = await operator.request.post('/api/quotes', {
      data: { rfqId, amount: 11000 },
    });
    expect(res.status()).toBe(409);
    expect(await res.text()).toContain('not accepting new offers');
  });

  await step('buyer resumes; the operator quotes normally', async () => {
    const rfq = buyer.locator(tidPrefix('buyer-rfq-')).first();
    const resumeResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/pause') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    // The same button toggles — paused state shows "Resume".
    await rfq.locator(tidPrefix('pause-rfq-')).click();
    await resumeResp;
    await expect(rfq.locator(tidPrefix('rfq-paused-'))).toHaveCount(0);

    await operator.goto('/app/rfqs');
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    await item.locator(tidPrefix('quote-amount-')).fill('11000');
    await item.locator(tidPrefix('quote-send-')).click();
    await expect(item).toContainText(/quote sent|sent/i);
  });
});
