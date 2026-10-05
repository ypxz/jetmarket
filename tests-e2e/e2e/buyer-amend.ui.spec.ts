// QA-481/482: buyer amends an RFQ inline on /quotes — the Edit button opens
// the field-def-driven form, Save PATCHes in place, and the echo line
// reflects the new details after reload. (API-level coverage lives in
// buyer-amend.api.spec.ts — this spec owns the UI path end-to-end.)
import { expect, test } from '@playwright/test';
import {
  createListing,
  createOperatorProfile,
  fillRfqForm,
  isoDateIn,
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
  let listingId = '';

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
    listingId = buyer.url().match(/\/rfq\/([^/?#]+)/)![1]!;
    await fillRfqForm(buyer, BUYER_EMAIL);
    await buyer.getByTestId('rfq-submit').click();
    await buyer.waitForURL(/\/rfq\/thanks/, { timeout: 15_000 });
    await expect(buyer.getByTestId('rfq-confirmation')).toBeVisible({
      timeout: 10_000,
    });
  });

  await step('operator sends a quote on the request', async () => {
    await operator.goto('/app/rfqs');
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    await item.locator(tidPrefix('quote-amount-')).fill('13500');
    await item.locator(tidPrefix('quote-send-')).click();
    await expect(item.locator(tidPrefix('op-quote-'))).toBeVisible({
      timeout: 15_000,
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
    // QA-487: the request still has ~16 days of horizon — Extend would
    // only 409, so the button isn't offered at all.
    await expect(rfq.locator(tidPrefix('extend-rfq-'))).toHaveCount(0);

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

    // QA-485: the offer sent BEFORE the amend is flagged — the buyer can
    // tell which quotes predate the latest request details.
    const quoteCard = buyer.locator('li[data-testid^="quote-"]').first();
    await expect(quoteCard.locator(tidPrefix('quote-stale-'))).toContainText(
      /before/i,
    );

    // QA-490: the offer card links through to the operator's public
    // profile — the trust-check that used to dead-end on a name.
    const profile = quoteCard.locator('a[data-testid^="op-profile-"]');
    await expect(profile).toBeVisible();
    expect(await profile.getAttribute('href')).toContain('/operators/');
  });

  await step('the amendment survives a reload', async () => {
    await buyer.reload();
    const rfq = buyer.locator(tidPrefix('buyer-rfq-')).first();
    await expect(rfq.locator(tidPrefix('rfq-echo-'))).toContainText('GVA');
    await expect(
      rfq.locator(tidPrefix('quote-stale-')),
    ).toBeVisible();
  });

  await step('operator inbox shows the "Buyer edited" trail (QA-536)', async () => {
    await operator.goto('/app/rfqs');
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    const trail = item.locator(tidPrefix('amendhist-'));
    await expect(trail).toBeVisible();
    // One amend rung: departure e2e → GVA, labelled by the field def.
    const rung = trail.locator(tidPrefix('amend-'));
    await expect(rung).toHaveCount(1);
    await expect(rung).toContainText('e2e');
    await expect(rung).toContainText('GVA');
  });

  await step('operator revision clears the pre-update flag', async () => {
    const opQuote = operator.locator(tidPrefix('op-quote-')).first();
    await expect(opQuote).toBeVisible();
    // The form mounts on toggle — before that the revise-* match is unique.
    await opQuote.locator('button[data-testid^="revise-"]').click();
    await opQuote.locator('input[data-testid^="revise-amount-"]').fill('12800');
    // Wait for the revise POST itself — the row's state stays 'sent'
    // through a revision, so text asserts can't order us after the write.
    const revised = operator.waitForResponse(
      (r) => r.url().includes('/revise') && r.ok(),
      { timeout: 15_000 },
    );
    await opQuote
      .locator('button[data-testid^="revise-save-"]')
      .click();
    await revised;

    await buyer.reload();
    const rfq = buyer.locator(tidPrefix('buyer-rfq-')).first();
    const quoteCard = rfq.locator('li[data-testid^="quote-"]').first();
    // revised after the amend → no stale flag; the QA-445 Updated chip shows
    await expect(quoteCard.locator(tidPrefix('quote-stale-'))).toHaveCount(0);
    await expect(
      quoteCard.locator(tidPrefix('quote-updated-')),
    ).toBeVisible();
  });

  await step('a new offer lands on focus-refresh — no manual reload (QA-491)', async () => {
    // The whole-mailbox refresh is the signed-in path (sessionOwns): a
    // guest's per-RFQ bearer token deliberately scopes the inbox to that
    // one request, so exercise this on the session view.
    await signUpAndLogin(buyer, BUYER_EMAIL, 'buyer');
    await buyer.goto('/quotes');
    await expect(buyer.locator(tidPrefix('buyer-rfq-'))).toHaveCount(1);

    // Mint a second request + quote out-of-band while the buyer tab stays
    // parked on /quotes — the real-world "left it open" case. The page's
    // own request contexts carry each actor's session cookies.
    const rfqRes = await buyer.request.post('/api/rfqs', {
      data: {
        listingId,
        buyerEmail: BUYER_EMAIL,
        fields: {
          departure: 'ZRH',
          arrival: 'NCE',
          dateFrom: isoDateIn(14),
          dateTo: isoDateIn(16),
          passengers: 2,
          name: 'Focus Buyer',
          email: BUYER_EMAIL,
        },
      },
    });
    expect(rfqRes.status()).toBe(201);
    const { rfqId: rfq2 } = (await rfqRes.json()) as { rfqId: string };
    const q2 = await operator.request.post('/api/quotes', {
      data: { rfqId: rfq2, amount: 12100, currency: 'USD', message: 'second' },
    });
    expect(q2.status()).toBe(201);

    // Synthetic tab-return: headless pages stay visible+focused so
    // bringToFront fires nothing — dispatch the same 'focus' event a real
    // return delivers, and wait for the refetch it must trigger.
    const refreshed = buyer.waitForResponse(
      (r) => r.url().includes('/api/buyer/quotes') && r.ok(),
      { timeout: 15_000 },
    );
    await buyer.evaluate(() => window.dispatchEvent(new Event('focus')));
    await refreshed;
    await expect(buyer.locator(tidPrefix('buyer-rfq-'))).toHaveCount(2, {
      timeout: 10_000,
    });
  });
});
