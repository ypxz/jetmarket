// QA-530 quote revise history: a successful revise writes the superseded
// terms to quote_revisions inside the CAS, and the buyer's /quotes card
// shows the ladder — "Revised — was $X before <date>" newest-first.
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
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.22.7' } });

const run = Date.now().toString(36);
const OPERATOR_EMAIL = `e2e-ui-hist-ops-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-ui-hist-buyer-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E UI History Charter ${run}`;

test('operator revises a quote; buyer inbox shows the superseded price', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const operator = await browser.newPage();
  const buyer = await browser.newPage();

  await step('operator signs up and lists a charter', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E History Ops ${run}`,
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

  await step('operator quotes 12,000 then revises to 10,500', async () => {
    await operator.goto('/app/rfqs');
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    await item.locator(tidPrefix('quote-amount-')).fill('12000');
    const sendResp = operator.waitForResponse(
      (r) =>
        r.url().includes('/api/quotes') &&
        r.request().method() === 'POST' &&
        r.status() === 201,
    );
    await item.locator(tidPrefix('quote-send-')).click();
    await sendResp;
    await expect(item).toContainText(/quote sent|sent/i);

    await item.locator(`button${tidPrefix('revise-')}`).first().click();
    await item.locator(tidPrefix('revise-amount-')).fill('10500');
    const revResp = operator.waitForResponse(
      (r) =>
        r.url().includes('/revise') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await item.locator(tidPrefix('revise-save-')).click();
    await revResp;
  });

  await step('buyer inbox shows the revised price + the superseded rung', async () => {
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
    // Current terms lead the card…
    await expect(quote).toContainText(/10,?500/);
    // …and the superseded 12,000 sits on the history rung.
    const trail = quote.locator(tidPrefix('quotehistory-'));
    await expect(trail).toBeVisible();
    await expect(trail).toContainText(/Revised/i);
    await expect(trail).toContainText(/12,?000/);
    await expect(quote.locator(tidPrefix('quoterev-'))).toHaveCount(1);
    // QA-531: first-ever look at these terms — the "New" chip rides.
    await expect(quote.locator(tidPrefix('quote-new-'))).toBeVisible();
  });

  await step('a second revise re-flags New and adds a rung (QA-531)', async () => {
    await operator.goto('/app/rfqs');
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    await item.locator(`button${tidPrefix('revise-')}`).first().click();
    await item.locator(tidPrefix('revise-amount-')).fill('9800');
    const revResp = operator.waitForResponse(
      (r) =>
        r.url().includes('/revise') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await item.locator(tidPrefix('revise-save-')).click();
    await revResp;

    const loadResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/api/buyer/quotes') &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
    await buyer.reload();
    await loadResp;
    const quote = buyer.locator(tidPrefix('quote-')).first();
    // The revise cleared the seen stamp — new terms re-flag New.
    await expect(quote.locator(tidPrefix('quote-new-'))).toBeVisible();
    await expect(quote).toContainText(/9,?800/);
    // Two rungs now: the 10,500 just replaced leads, the 12,000 trails.
    const revs = quote.locator(tidPrefix('quoterev-'));
    await expect(revs).toHaveCount(2);
    await expect(revs.first()).toContainText(/10,?500/);
    await expect(revs.last()).toContainText(/12,?000/);

    // And the chip retires once this load stamped the new terms.
    const loadResp2 = buyer.waitForResponse(
      (r) =>
        r.url().includes('/api/buyer/quotes') &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
    await buyer.reload();
    await loadResp2;
    await expect(
      buyer.locator(tidPrefix('quote-')).first().locator(tidPrefix('quote-new-')),
    ).toHaveCount(0);
  });

  await step('the operator inbox shows their own ladder (QA-532)', async () => {
    await operator.goto('/app/rfqs');
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    const trail = item.locator(tidPrefix('oprevhist-'));
    await expect(trail).toBeVisible();
    const revs = item.locator(tidPrefix('oprev-'));
    await expect(revs).toHaveCount(2);
    // Same newest-first order the buyer sees: 10,500 led, 12,000 trails.
    await expect(revs.first()).toContainText(/10,?500/);
    await expect(revs.last()).toContainText(/12,?000/);
  });
});
