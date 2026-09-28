// Regression: unmatched paths + notFound() pages must return HTTP 404.
// A loading.tsx above a notFound()-capable page wraps it in Suspense and
// flushes a 200 before notFound() resolves (Next.js #76474) — keep
// loading.tsx out of the [locale] segment root AND the (public) group;
// leaf loaders that never notFound (e.g. search/loading.tsx) are fine.
// Exercises public pages only (no auth).
import { expect, test } from '@playwright/test';

// Isolated rate-limit bucket per spec file — the dev server keeps
// buckets across the whole suite run (and across runs when reused), so
// shared 'local' IP logins exhaust ml:*/30ph mid-suite (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.14.7' } });

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
