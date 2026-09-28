import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const OUT = 'docs/screens';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${BASE}/`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${OUT}/landing.png` });

  await page.goto(`${BASE}/search`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${OUT}/search.png` });

  const first = await page
    .locator('a[href^="/listing/"]')
    .first()
    .getAttribute('href');
  if (first) {
    await page.goto(`${BASE}${first}`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `${OUT}/listing.png` });
  }

  // admin: mock magic-link sign-in (devLink rendered on /sign-in);
  // ADMIN_EMAILS default promotes admin@jetmarket.local to admin role.
  await page.goto(`${BASE}/sign-in`);
  await page.getByTestId('signin-email').fill('admin@jetmarket.local');
  await page.getByTestId('signin-submit').click();
  const devLink = page.getByTestId('signin-devlink');
  await devLink.waitFor({ timeout: 30_000 });
  await devLink.click();
  await page.getByTestId('confirm-signin').click();
  await page.waitForLoadState('networkidle');
  await page.goto(`${BASE}/admin`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${OUT}/admin.png` });

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
