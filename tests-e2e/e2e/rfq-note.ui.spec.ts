// QA-524: operator triage notes — a private note field on every inbox row;
// it survives reloads and edits, and an empty save clears it. Only the
// owning operator ever sees it.
import { expect, test } from '@playwright/test';
import {
  createListing,
  createOperatorProfile,
  fillRfqForm,
  signUpAndLogin,
  step,
} from '../helpers/flow';

// Isolated rate-limit bucket per spec file (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.17.4' } });

const run = Date.now().toString(36);
const OPERATOR_EMAIL = `e2e-ui-note-ops-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-ui-note-buyer-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E UI Note Charter ${run}`;

test('operator keeps a private note on an inbox RFQ row', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const operator = await browser.newPage();
  const buyer = await browser.newPage();

  await step('operator signs up and lists a charter', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E Note Ops ${run}`,
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
    // Wait on the redirect — /rfq/thanks can take seconds under cold compile.
    await buyer.waitForURL(/\/rfq\/thanks/, { timeout: 15_000 });
    await expect(buyer.getByTestId('rfq-confirmation')).toBeVisible({
      timeout: 10_000,
    });
  });

  const row = () =>
    operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE })
      .first();
  const editBtn = () => row().getByTestId(/^rfq-note-edit-/);
  const input = () => row().getByTestId(/^rfq-note-input-/);
  const saveBtn = () => row().getByTestId(/^rfq-note-save-/);

  await step('operator adds a note; it persists across reloads', async () => {
    await operator.goto('/app/rfqs');
    await expect(row()).toBeVisible({ timeout: 30_000 });
    // Warm the new route's on-demand compile: a cold first POST to a
    // freshly-compiled route can arrive body-less under next dev (the
    // request is held during compile and the body stream is dropped),
    // which made the save land as a 400 'invalid JSON body' in-suite.
    await operator.request.get(
      '/api/operator/rfqs/00000000-0000-4000-8000-000000000000/note',
    );
    await editBtn().click();
    await input().fill('Called them — price shopper');
    await saveBtn().click();
    // Saved state: the note line renders and the toggle flips to Edit.
    await expect(editBtn()).toHaveText('Edit note', { timeout: 10_000 });
    await expect(
      row().getByText('Called them — price shopper'),
    ).toBeVisible();
    // Reload → note still there (server round-trip, not local state).
    await operator.reload();
    await expect(
      row().getByText('Called them — price shopper'),
    ).toBeVisible({ timeout: 30_000 });
  });

  await step('operator edits the note', async () => {
    await editBtn().click();
    await input().fill('Follow up Monday');
    await saveBtn().click();
    await expect(row().getByText('Follow up Monday')).toBeVisible({
      timeout: 10_000,
    });
    await expect(row().getByText('Called them')).toHaveCount(0);
  });

  await step('clearing the note removes it', async () => {
    await editBtn().click();
    await input().fill('');
    await saveBtn().click();
    await expect(row().getByText('Follow up Monday')).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(editBtn()).toHaveText('Add note');
    await operator.reload();
    await expect(editBtn()).toHaveText('Add note', { timeout: 30_000 });
  });
});
