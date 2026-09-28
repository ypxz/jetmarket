// Edit-listing flow at UI level: dashboard row → edit page → PATCH →
// dashboard re-render. API-level PATCH coverage lives in lifecycle.api.spec.ts;
// this spec exercises the edit page + form contract (TESTIDS.md).
import { expect, test } from '@playwright/test';
import {
  createListing,
  createOperatorProfile,
  signUpAndLogin,
  step,
} from '../helpers/flow';

// Isolated rate-limit bucket per spec file — the dev server keeps
// buckets across the whole suite run (and across runs when reused), so
// shared 'local' IP logins exhaust ml:*/30ph mid-suite (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.11.7' } });

const run = Date.now();
const OPERATOR_EMAIL = `e2e-ui-edit-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E UI Edit ${run}`;
const EDITED_TITLE = `${LISTING_TITLE} — edited`;

test('listing edit UI: dashboard → edit → save → dashboard reflects changes', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const operator = await browser.newPage();

  await step('operator signs up and creates a listing', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E UI Edit Ops ${run}`,
      baseAirport: 'LSZH',
    });
    await createListing(operator, {
      type: 'charter',
      title: LISTING_TITLE,
      price: '38000',
      fields: {
        aircraftCategory: 'light',
        model: 'Phenom 300',
        seats: '7',
        year: '2019',
        baseAirport: 'ZRH',
      },
    });
    await expect(operator).toHaveURL(/\/app/);
    // router.push returns before the RSC refetch lands — wait for the row.
    await expect(
      operator.locator('li').filter({ hasText: LISTING_TITLE }),
    ).toBeVisible({ timeout: 30_000 });
  });

  let listingId = '';
  await step('dashboard row exposes an edit CTA that opens the edit page', async () => {
    const row = operator
      .locator('li')
      .filter({ hasText: LISTING_TITLE })
      .first();
    const editLink = row.getByTestId(/^edit-listing-/);
    await expect(editLink).toBeVisible();
    listingId = (await editLink.getAttribute('data-testid'))!.replace(
      'edit-listing-',
      '',
    );
    await editLink.click();
    await expect(operator).toHaveURL(
      new RegExp(`/app/listings/${listingId}/edit`),
      { timeout: 30_000 },
    );
  });

  await step('edit form is prefilled, saves title+price, returns to dashboard', async () => {
    const title = operator.getByTestId('edit-title');
    await expect(title).toHaveValue(LISTING_TITLE);
    const price = operator.getByTestId('edit-price');
    await expect(price).toHaveValue('38000');
    await title.fill(EDITED_TITLE);
    await price.fill('41000');
    await operator.getByTestId('edit-save').click();
    await expect(operator).toHaveURL(/\/app\/?$/, { timeout: 30_000 });
    await expect(
      operator.locator('li').filter({ hasText: EDITED_TITLE }),
    ).toBeVisible();
  });

  await step('public listing page shows the edited title', async () => {
    await operator.goto(`/listing/${listingId}`);
    await expect(operator.getByTestId('listing-title')).toContainText(EDITED_TITLE);
  });
});
