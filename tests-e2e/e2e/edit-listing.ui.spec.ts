// Edit-listing flow at UI level: dashboard row → edit page → PATCH →
// dashboard re-render. API-level PATCH coverage lives in lifecycle.api.spec.ts;
// this spec exercises the edit page + form contract (TESTIDS.md).
import { expect, test } from '@playwright/test';
import postgres from 'postgres';
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

  await step('each public render bumps views once — counter, not stat (QA-413)', async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
    try {
      const [before] = await sql`
        select views from listings where id = ${listingId}`;
      // One more full page load — exactly one bump (generateMetadata + page
      // share the request-scoped cache() around the write).
      await operator.goto(`/listing/${listingId}`);
      const [row] = await sql`
        select views from listings where id = ${listingId}`;
      expect(row?.views).toBe((before?.views ?? 0) + 1);
      // Below the social-proof threshold the public page shows no count.
      await expect(operator.getByTestId('view-count')).toHaveCount(0);
    } finally {
      await sql.end();
    }
  });

  await step('duplicate clones to a draft and lands on its editor (QA-412)', async () => {
    await operator.goto('/app');
    const row = operator
      .locator('li')
      .filter({ hasText: EDITED_TITLE })
      .first();
    const dupBtn = row.getByTestId(/^duplicate-listing-/);
    await expect(dupBtn).toBeVisible();
    await dupBtn.click();
    // Lands straight on the copy's editor — a different listing id.
    await expect(operator).toHaveURL(
      new RegExp(`/app/listings/(?!${listingId}\\b)[0-9a-f-]{36}/edit`),
      { timeout: 30_000 },
    );
    await expect(operator.getByTestId('edit-title')).toHaveValue(
      `${EDITED_TITLE} (copy)`,
    );
    await expect(operator.getByTestId('edit-price')).toHaveValue('41000');
    // The copy is a draft — back on the dashboard it never activated.
    await operator.goto('/app');
    const copyRow = operator
      .locator('li')
      .filter({ hasText: '(copy)' })
      .first();
    await expect(copyRow).toBeVisible();
    await expect(copyRow).toContainText('draft');
  });

  await step('delete removes the draft copy; live listings refuse (QA-419)', async () => {
    // The draft copy carries a Delete action — two clicks (arm, confirm).
    const copyRow = operator
      .locator('li')
      .filter({ hasText: '(copy)' })
      .first();
    const delBtn = copyRow.getByTestId(/^delete-listing-/);
    await expect(delBtn).toBeVisible();
    await delBtn.click();
    await expect(delBtn).toContainText('Delete forever');
    await delBtn.click();
    await expect(copyRow).toHaveCount(0, { timeout: 15_000 });
    // The still-active edited listing offers no delete; a direct DELETE is
    // refused so live demand can't be pulled out from under buyers.
    const editedRow = operator
      .locator('li')
      .filter({ hasText: EDITED_TITLE })
      .filter({ hasNotText: '(copy)' })
      .first();
    await expect(editedRow.getByTestId(/^delete-listing-/)).toHaveCount(0);
    const res = await operator.request.delete(
      `/api/listings/${listingId}`,
    );
    expect(res.status()).toBe(409);
  });
});
