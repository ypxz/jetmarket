// SEO landing pages (QA-287): configured slugs had zero in-suite coverage.
// Pins page render + JSON-LD escaping + unknown-slug 404.
import { expect, test } from '@playwright/test';

// Isolated rate-limit bucket per spec file — the dev server keeps
// buckets across the whole suite run (and across runs when reused), so
// shared 'local' IP logins exhaust ml:*/30ph mid-suite (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.18.7' } });

test('seo landing page renders filtered results + safe JSON-LD', async ({
  page,
}) => {
  const res = await page.goto('/empty-legs-zurich-nice');
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId('seo-page')).toBeVisible();
  // Filtered badge names the listing type from the page's filters.
  await expect(page.getByText('Empty leg').first()).toBeVisible();
  // Results or the documented empty state — seeded data has ZRH->NCE legs.
  await expect(page.getByTestId('seo-result-count')).toBeVisible();
  // JSON-LD must stay escaped — a raw '<' in the script body would break
  // out of the tag (the page renders user-seeded titles).
  const ld = await page
    .locator('script[type="application/ld+json"]')
    .textContent();
  expect(ld).toBeTruthy();
  expect(ld).not.toContain('</');
  const parsed = JSON.parse(ld!) as { '@type': string };
  expect(parsed['@type']).toBe('ItemList');
});

test('unknown slug 404s', async ({ page }) => {
  const res = await page.goto('/not-a-real-landing-page');
  expect(res?.status()).toBe(404);
});

// Operator directory (QA-426): indexable parent of /operators/[id] —
// cards carry the active count and link through to the profile.
test('operator directory lists seeded operators and links to profiles', async ({
  page,
}) => {
  const res = await page.goto('/operators');
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId('operators-index-title')).toBeVisible();
  const cards = page.locator('[data-testid^="operator-card-"]');
  expect(await cards.count()).toBeGreaterThan(0);
  // Counts are active-only: at least one card shows "Active listings (N)".
  await expect(page.getByText(/Active listings \(\d+\)/).first()).toBeVisible();
  // Indexable surface: no robots noindex marker. all() doesn't wait — a
  // missing meta[name=robots] element IS the indexable state.
  const robots = await Promise.all(
    (await page.locator('meta[name="robots"]').all()).map((m) =>
      m.getAttribute('content'),
    ),
  );
  expect(robots.join(' ')).not.toContain('noindex');
  const firstProfile = cards
    .first()
    .getByRole('link', { name: 'View profile' });
  await firstProfile.click();
  // 30s: a cold dev-compile of /operators/[id] (~10s compile + ~10s render)
  // can outlast the default URL timeout (QA-494).
  await expect(page).toHaveURL(/\/operators\/[0-9a-f-]{36}$/, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('operator-name')).toBeVisible({
    timeout: 30_000,
  });
});

// Locale alternates (QA-497): translated indexable pages self-canonical and
// advertise the hreflang pair so /de can rank instead of collapsing onto the
// English URL. The sitemap carries the same map as xhtml:link alternates.
test('de landing page self-canonicals and lists hreflang alternates', async ({
  page,
}) => {
  const res = await page.goto('/de/empty-legs-zurich-nice');
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId('seo-page')).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/de\/empty-legs-zurich-nice$/,
  );
  await expect(
    page.locator('link[rel="alternate"][hreflang="de"]'),
  ).toHaveAttribute('href', /\/de\/empty-legs-zurich-nice$/);
  const enAlt = page.locator('link[rel="alternate"][hreflang="en"]');
  await expect(enAlt).toHaveAttribute(
    'href',
    /\/empty-legs-zurich-nice$/,
  );
  expect(await enAlt.getAttribute('href')).not.toContain('/de/');
  await expect(
    page.locator('link[rel="alternate"][hreflang="x-default"]'),
  ).toHaveAttribute('href', /\/empty-legs-zurich-nice$/);
});

test('en page canonical + alternates stay unprefixed', async ({ page }) => {
  const res = await page.goto('/empty-legs-zurich-nice');
  expect(res?.status()).toBe(200);
  const canonical = page.locator('link[rel="canonical"]');
  await expect(canonical).toHaveAttribute(
    'href',
    /\/empty-legs-zurich-nice$/,
  );
  expect(await canonical.getAttribute('href')).not.toContain('/de/');
});

test('sitemap.xml emits xhtml:link alternates for de', async ({ request }) => {
  const res = await request.get('/sitemap.xml');
  expect(res.status()).toBe(200);
  const xml = await res.text();
  expect(xml).toContain('xhtml:link');
  expect(xml).toContain('hreflang="de"');
  expect(xml).toContain('hreflang="x-default"');
  // The /de counterpart of a seeded SEO slug is advertised.
  expect(xml).toContain('/de/empty-legs-zurich-nice');
  // No /de prefix ever lands inside an en href.
  expect(xml).not.toMatch(/hreflang="en" href="[^"]*\/de\//);
});
