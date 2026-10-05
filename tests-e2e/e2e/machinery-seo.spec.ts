// Machinery public surface (QA-553): the machinery deploy's indexable
// funnel — SEO landings, sitemap, operator directory — had zero coverage
// (the jets seo-pages spec only exercises the jets config). The slugs,
// copy and filters all resolve off the vertical config, so a machinery
// boot must produce machinery landings in both locales out of the box.
import { expect, test } from '@playwright/test';

// Own bucket — the machinery suite shares the dev server's rate limiter.
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.14.7' } });

test.beforeEach(() => {
  test.skip(process.env.VERTICAL !== 'machinery', 'run with VERTICAL=machinery');
});

test('machinery seo landing renders filtered results + safe JSON-LD', async ({
  page,
}) => {
  const res = await page.goto('/used-lathes-for-sale');
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId('seo-page')).toBeVisible();
  // Configured copy, not the raw key (vertical.machinery.seo.pages.*).
  await expect(
    page.getByRole('heading', { name: 'Used lathes for sale' }),
  ).toBeVisible();
  // Seed pins two for_sale lathes (ibérica-maquinaria's Okuma + Puma) —
  // the count badge must reflect the machineryCategory+type filter, not
  // the whole book.
  await expect(page.getByTestId('seo-result-count')).toContainText('2');
  await expect(page.getByText('Okuma').first()).toBeVisible();
  await expect(page.getByText('PUMA').first()).toBeVisible();
  const ld = await page
    .locator('script[type="application/ld+json"]')
    .textContent();
  expect(ld).toBeTruthy();
  expect(ld).not.toContain('</');
  expect(JSON.parse(ld!)['@type']).toBe('ItemList');
});

test('machinery landing renders German copy under /de', async ({ page }) => {
  const res = await page.goto('/de/used-lathes-for-sale');
  expect(res?.status()).toBe(200);
  await expect(
    page.getByRole('heading', {
      name: 'Gebrauchte Drehmaschinen zu verkaufen',
    }),
  ).toBeVisible();
});

test('machinery sitemap advertises the vertical slugs + /de alternates', async ({
  request,
}) => {
  const res = await request.get('/sitemap.xml');
  expect(res.status()).toBe(200);
  const xml = await res.text();
  // A machinery landing slug — not a jets one.
  expect(xml).toContain('used-lathes-for-sale');
  expect(xml).toContain('industrial-generators-for-rent');
  expect(xml).not.toContain('empty-legs-zurich-nice');
  // hreflang alternates: every slug also resolves under /de.
  expect(xml).toContain('/de/used-lathes-for-sale');
});

test('unknown machinery slug 404s', async ({ page }) => {
  const res = await page.goto('/not-a-real-machine-page');
  expect(res?.status()).toBe(404);
});

test('machinery operator directory lists seeded dealers', async ({ page }) => {
  const res = await page.goto('/operators');
  expect(res?.status()).toBe(200);
  const cards = page.locator('[data-testid^="operator-card-"]');
  expect(await cards.count()).toBeGreaterThan(0);
  await expect(page.getByText('Alpine Werkzeugmaschinen')).toBeVisible();
});
