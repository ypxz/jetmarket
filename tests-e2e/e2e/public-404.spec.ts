// Regression: unmatched paths + notFound() pages must return HTTP 404.
// A locale-level loading.tsx wraps every page in Suspense, which flushes a
// 200 before notFound() resolves (Next.js #76474) — keep loading.tsx out of
// the [locale] segment root. Exercises public pages only (no auth).
import { expect, test } from '@playwright/test';

const MISSING = '00000000-0000-0000-0000-000000000000';

test('missing listing / operator / catch-all pages return 404', async ({
  request,
}) => {
  for (const path of [
    `/listing/${MISSING}`,
    `/operators/${MISSING}`,
    '/no-such-page-at-all',
  ]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
  }
});

test('operator profile renders name, badge and listings', async ({
  page,
  request,
}) => {
  const listings = await (
    await request.get('/api/listings?limit=1')
  ).json();
  const operatorId = listings[0].operatorId as string;

  await page.goto(`/operators/${operatorId}`);
  await expect(page.getByTestId('operator-name')).toBeVisible();
  await expect(page.getByTestId('operator-listings')).toBeVisible();
  await expect(
    page.getByTestId('operator-listings').getByRole('link').first(),
  ).toBeVisible();
});

test('listing page links to the operator profile', async ({ page, request }) => {
  const listings = await (await request.get('/api/listings?limit=1')).json();
  const listing = listings[0];

  await page.goto(`/listing/${listing.id}`);
  const link = page.getByTestId('listing-operator-link');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute(
    'href',
    `/operators/${listing.operatorId}`,
  );
});
