// Static + legal pages (QA-288): last uncovered render surface — legal
// pages do placeholder substitution that throws on a missing key, the
// /design gallery must stay noindex (QA-275), /rfq/thanks renders the
// confirmation card.
import { expect, test } from '@playwright/test';

// Isolated rate-limit bucket per spec file — the dev server keeps
// buckets across the whole suite run (and across runs when reused), so
// shared 'local' IP logins exhaust ml:*/30ph mid-suite (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.19.7' } });

test('legal pages render with entity substitution', async ({ page }) => {
  for (const path of ['/tos', '/privacy', '/imprint']) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    // Placeholder {entity} is substituted — a raw '{' left in the output
    // would mean the legal body shipped un-substituted.
    await expect(page.locator('body')).not.toContainText('{entity}');
    await expect(page.locator('body')).not.toContainText('{email}');
  }
});

test('/rfq/thanks renders the confirmation card', async ({ page }) => {
  const res = await page.goto('/rfq/thanks');
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId('rfq-confirmation')).toBeVisible();
});

test('/design stays noindex', async ({ page }) => {
  const res = await page.goto('/design');
  expect(res?.status()).toBe(200);
  const robots = await page.locator('meta[name="robots"]').getAttribute('content');
  expect(robots).toContain('noindex');
});

test('/de renders German copy and the locale switcher round-trips (QA-492)', async ({
  page,
}) => {
  // Landing under /de serves the German catalog.
  const res = await page.goto('/de');
  expect(res?.status()).toBe(200);
  await expect(page.locator('body')).toContainText('Charter, Leerflüge');
  await expect(
    page.getByRole('button', { name: 'Flugzeuge durchsuchen' }),
  ).toBeVisible();

  // Switcher offers the OTHER locale — EN on /de.
  const sw = page.getByTestId('locale-switch');
  await expect(sw).toHaveText('EN');

  // Query params survive the switch: /de/search?verified=1 → /search?verified=1.
  await page.goto('/de/search?verified=1');
  await page.getByTestId('locale-switch').click();
  await page.waitForURL(/\/search\?verified=1$/);
  await expect(page.getByTestId('locale-switch')).toHaveText('DE');
  await expect(page.locator('h1')).toHaveText('Search listings');
});

test('/de search alert renders the ICU {count} template client-side (QA-492)', async ({
  page,
}) => {
  // search.alertMatched is a raw template — the alert form substitutes
  // {count} itself after the POST; t() must not eagerly ICU-format it
  // (FORMATTING_ERROR → next-intl key fallback). Assert the German label
  // lands with a real count after submit.
  await page.goto('/de/search');
  await page.getByTestId('search-alert-email').fill('de-alert@example.test');
  // Wait on the POST — a cold route compile eats the default 10s DOM window.
  const subResp = page.waitForResponse(
    (r) =>
      r.url().includes('/api/search-alerts') &&
      r.request().method() === 'POST' &&
      r.status() === 200,
  );
  await page.getByTestId('search-alert-submit').click();
  await subResp;
  await expect(page.getByTestId('search-alert-matched')).toHaveText(
    /^Aktuell live: „\d+“$/,
  );
});
