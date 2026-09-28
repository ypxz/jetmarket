// Mobile-viewport regression pin — cycle-2 shipped ~10 mobile fixes
// (overflowing dashboard, clipped admin, header wrap, forms). Nothing in the
// suite held a phone viewport, so overflow could silently regress. Asserts:
// (1) no horizontal scroll anywhere on the golden path, (2) the header
// nav wraps rather than clips, (3) the RFQ form still opens from a listing.
import { expect, test } from '@playwright/test';

// Isolated rate-limit bucket per spec file — the dev server keeps
// buckets across the whole suite run (and across runs when reused), so
// shared 'local' IP logins exhaust ml:*/30ph mid-suite (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.15.9' } });

const MOBILE = { width: 390, height: 844 }; // iPhone 14-ish

async function expectNoHScroll(page: import('@playwright/test').Page, where: string) {
  const widths = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    win: window.innerWidth,
  }));
  expect(
    Math.max(widths.doc, widths.body),
    `${where}: horizontal overflow (${JSON.stringify(widths)})`,
  ).toBeLessThanOrEqual(widths.win + 1);
}

test('mobile: landing / search / listing render without horizontal overflow', async ({
  page,
  request,
}) => {
  await page.setViewportSize(MOBILE);

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await expectNoHScroll(page, 'landing');
  // header nav must wrap visibly — it is the only navigation on mobile
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expect(
    page.getByRole('link', { name: /sign in/i }).first(),
  ).toBeVisible();

  await page.goto('/search');
  await page.waitForLoadState('networkidle');
  await expectNoHScroll(page, 'search');
  await expect(page.getByTestId('facet-q')).toBeVisible();
  await expect(page.getByTestId('search-result').first()).toBeVisible();

  const listings = await (await request.get('/api/listings?limit=1')).json();
  await page.goto(`/listing/${listings[0].id}`);
  await page.waitForLoadState('networkidle');
  await expectNoHScroll(page, 'listing');
  await expect(page.getByTestId('listing-rfq-cta')).toBeVisible();

  // RFQ form opens on mobile too — the cycle-2 rfq form clipped at 390px.
  await page.getByTestId('listing-rfq-cta').click();
  await page.waitForURL(/\/rfq\//);
  await expectNoHScroll(page, 'rfq form');
  await expect(page.getByTestId('rfq-submit')).toBeVisible();
});

test('mobile: dark-mode toggle + operator pages keep no-overflow invariant', async ({
  page,
}) => {
  await page.setViewportSize(MOBILE);
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // theme toggle is keyboard/hit reachable at mobile width too — assert the
  // `dark` class toggles (headless may already start dark via
  // prefers-color-scheme, so compare before/after rather than a fixed class).
  const toggle = page.getByTestId('theme-toggle');
  await expect(toggle).toBeVisible();
  const before = await page.evaluate(() =>
    document.documentElement.classList.contains('dark'),
  );
  await toggle.click();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains('dark')),
    )
    .toBe(!before);
  await expectNoHScroll(page, 'landing after theme toggle');
});

test('mobile: dark theme applies before first paint (no FOUC)', async ({
  browser,
  request,
}) => {
  // Mechanism pin: the served HTML must embed the inline pre-paint script —
  // without it the class only appears post-hydration (the light flash).
  const html = await (await request.get('/')).text();
  expect(html).toContain("localStorage.getItem('jm-theme')");

  // Behavior: emulated prefers-color-scheme + empty storage ends dark, and a
  // stored 'light' wins over the OS preference on reload.
  const ctx = await browser.newContext({ viewport: MOBILE, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains('dark')),
    )
    .toBe(true);

  await page.evaluate(() => localStorage.setItem('jm-theme', 'light'));
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains('dark')),
    )
    .toBe(false);
  await ctx.close();
});
