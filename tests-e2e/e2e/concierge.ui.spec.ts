// Buyer concierge UI: after submitting an RFQ the thanks page offers the
// $49 expedite (ConciergeCard resolves the #t= bearer token); clicking the
// CTA pays via the mock checkout's in-process webhook and the control
// settles into the "active" state. /quotes then shows the concierge badge
// instead of the upsell.
import { expect, test } from '@playwright/test';
import {
  createListing,
  createOperatorProfile,
  fillRfqForm,
  signUpAndLogin,
  step,
} from '../helpers/flow';

// Isolated rate-limit bucket per spec file (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.16.9' } });

const run = Date.now().toString(36);
const OPERATOR_EMAIL = `e2e-ui-concierge-ops-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-ui-concierge-buyer-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E UI Concierge Charter ${run}`;

test('buyer expedites a live RFQ from the thanks page; /quotes badges it', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const operator = await browser.newPage();
  const buyer = await browser.newPage();

  await step('operator signs up and lists a charter', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E Concierge Ops ${run}`,
      baseAirport: 'LSZH',
    });
    await createListing(operator, {
      type: 'charter',
      title: LISTING_TITLE,
      price: '12000',
      fields: {
        aircraftCategory: 'mid',
        model: 'PC-24',
        seats: '8',
        year: '2021',
        baseAirport: 'ZRH',
      },
    });
    await expect(operator).toHaveURL(/\/app/);
  });

  let rfqId = '';
  let token = '';
  await step('buyer sends an RFQ and lands on the thanks page', async () => {
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
    const url = new URL(buyer.url());
    rfqId = url.searchParams.get('id') ?? '';
    expect(rfqId).toBeTruthy();
    // `#t=...` — the bearer token never left the browser; carry it to /quotes.
    token = url.hash;
    expect(token).toContain('#t=');
  });

  await step('the thanks page offers concierge and the click activates it', async () => {
    const cta = buyer.getByTestId(`concierge-cta-${rfqId}`);
    await expect(cta).toBeVisible({ timeout: 10_000 });
    await cta.click();
    // Mock checkout auto-applies in-process — the control becomes a badge.
    await expect(
      buyer.getByTestId(`concierge-done-${rfqId}`),
    ).toBeVisible({ timeout: 15_000 });
    await expect(cta).toHaveCount(0);
  });

  await step('/quotes shows the concierge badge, not the upsell', async () => {
    // The bearer token lives in the thanks-page fragment; the buyer inbox
    // link resolves it client-side — navigate with the same fragment.
    await buyer.goto(
      `/quotes?email=${encodeURIComponent(BUYER_EMAIL)}${token}`,
    );
    await expect(buyer.getByTestId(`concierge-badge-${rfqId}`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(buyer.getByTestId(`concierge-cta-${rfqId}`)).toHaveCount(0);
  });
});
