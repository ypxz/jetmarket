// QA-194: buyer close-request at UI level — on /quotes the buyer ends an
// in-flight RFQ; the RFQ flips to closed and its sent quotes decline.
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
  let secondRfqId = '';

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
    const item = operator.locator('li[data-testid^="rfq-"]').filter({ hasText: LISTING_TITLE });
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
    // Wait on the network, not the DOM — a cold dev-compile of the close
    // route can eat the whole 10s expect window (QA-493).
    const closeResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/close') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await rfq.locator(tidPrefix('close-rfq-')).click();
    await closeResp;
    await expect(buyer.getByTestId('accept-msg')).toContainText(/closed/i);

    // after reload: status closed, no close button, quote shows declined
    await expect(rfq).toContainText('closed');
    await expect(rfq.locator(tidPrefix('close-rfq-'))).toHaveCount(0);
    const quote = rfq.locator(tidPrefix('quote-')).first();
    await expect(quote).toContainText('declined');
    await expect(quote.locator(tidPrefix('accept-'))).toHaveCount(0);
  });

  await step('operator finds the dead request under Lost (QA-537)', async () => {
    // The RFQ died AND this operator quoted on it — the f=lost view is
    // where the retrospective lives.
    await operator.goto('/app/rfqs?f=lost');
    const dead = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    await expect(dead).toBeVisible();
    await expect(dead.locator(tidPrefix('quote-state-'))).toContainText(
      /declined/i,
    );
    // The Answered view must not list it — no live quote in play. (The
    // Needs view may: a declined quote leaves it "needs action" even on a
    // dead RFQ — pre-existing semantics, unchanged by QA-537.)
    await operator.goto('/app/rfqs?f=answered');
    await expect(
      operator.locator('li[data-testid^="rfq-"]').filter({ hasText: LISTING_TITLE }),
    ).toHaveCount(0);
  });

  await step('closed RFQ reposts prefilled onto the live listing (QA-410)', async () => {
    // Terminal request + still-browseable listing → "Request again" hands the
    // field map to the RFQ form via sessionStorage.
    const rfq = buyer.locator(tidPrefix('buyer-rfq-')).first();
    await rfq.locator(tidPrefix('repost-rfq-')).click();
    await buyer.waitForURL(/\/rfq\//, { timeout: 15_000 });
    await expect(buyer.getByTestId('rfq-repost-note')).toBeVisible({
      timeout: 10_000,
    });
    // fillRfqForm wrote 'e2e' into text fields + the buyer email.
    await expect(buyer.getByTestId('rfq-field-departure')).toHaveValue('e2e');
    await expect(buyer.getByTestId('rfq-field-email')).toHaveValue(BUYER_EMAIL);
    // second open of the same form shows a blank field (stash consumed once)
    await buyer.reload();
    await expect(buyer.getByTestId('rfq-repost-note')).toHaveCount(0);
    await expect(buyer.getByTestId('rfq-field-departure')).toHaveValue('');
  });

  await step('closed zero-quote RFQ shows no waiting copy (QA-379)', async () => {
    // A request that ends before any quote arrives must not keep saying
    // "Waiting for operator quotes…" — the line used to render for every
    // zero-quote RFQ including closed ones.
    const lres = await buyer.request.get(
      `/api/listings?q=${encodeURIComponent(LISTING_TITLE)}&limit=1`,
    );
    const listing = (await lres.json())[0];
    const rres = await buyer.request.post('/api/rfqs', {
      data: {
        listingId: listing.id,
        buyerEmail: BUYER_EMAIL,
        fields: {
          departure: 'ZRH',
          arrival: 'LTN',
          dateFrom: isoDateIn(20),
          dateTo: isoDateIn(21),
          passengers: 5,
          name: 'Second Close',
          email: BUYER_EMAIL,
        },
      },
    });
    const created = await rres.json();
    secondRfqId = created.rfqId;
    await buyer.request.post(`/api/rfqs/${created.rfqId}/close`, {
      data: { buyerEmail: BUYER_EMAIL, token: created.accessToken },
    });
    // The inbox is token-scoped — load the second RFQ via its own #t= link.
    // Leave the page first: a hash-only goto doesn't remount it and the
    // mount-only token reader would keep the first RFQ's token.
    await buyer.goto('about:blank');
    await buyer.goto(`/quotes?email=${encodeURIComponent(BUYER_EMAIL)}#t=${created.accessToken}`);
    const closedEmpty = buyer.locator(tidPrefix('buyer-rfq-')).first();
    await expect(closedEmpty).toContainText('closed');
    await expect(closedEmpty).toContainText('Second Close');
    await expect(closedEmpty).not.toContainText('Waiting for operator quotes');
  });

  await step('buyer reopens a closed RFQ from /account (QA-540)', async () => {
    // A buyer session on the same email proves the mailbox — /account's
    // Reopen control reuses the session-auth branch of buyerAuthorized,
    // no #t= juggling needed. `secondRfqId` (the Second Close RFQ) still has
    // a live horizon (dateTo is weeks out), so reopen is allowed.
    await signUpAndLogin(buyer, BUYER_EMAIL);
    await buyer.goto('/account');
    const row = buyer.getByTestId(`account-rfq-${secondRfqId}`);
    await expect(row).toContainText('closed');
    const reopenResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/reopen') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await buyer.getByTestId(`account-rfq-reopen-${secondRfqId}`).click();
    await reopenResp;
    await expect(
      buyer.getByTestId(`account-rfq-reopened-${secondRfqId}`),
    ).toBeVisible();
    await buyer.reload();
    await expect(row).toContainText('open');
    // The persisted match re-enters the live inbox (closed rows are
    // filtered out of the default view) and the op can offer again —
    // their old declined quote stays history, the form re-renders.
    await operator.goto('/app/rfqs');
    const back = operator.getByTestId(`rfq-${secondRfqId}`);
    await expect(back).toBeVisible({ timeout: 15_000 });
    await expect(
      back.getByTestId(`quote-amount-${secondRfqId}`),
    ).toBeVisible();
  });
});
