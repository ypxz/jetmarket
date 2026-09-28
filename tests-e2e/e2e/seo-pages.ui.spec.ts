// SEO landing pages (QA-287): configured slugs had zero in-suite coverage.
// Pins page render + JSON-LD escaping + unknown-slug 404.
import { expect, test } from '@playwright/test';

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
