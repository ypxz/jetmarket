// Static + legal pages (QA-288): last uncovered render surface — legal
// pages do placeholder substitution that throws on a missing key, the
// /design gallery must stay noindex (QA-275), /rfq/thanks renders the
// confirmation card.
import { expect, test } from '@playwright/test';

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
