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
  await expect(page).toHaveURL(/\/operators\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('operator-name')).toBeVisible();
});
