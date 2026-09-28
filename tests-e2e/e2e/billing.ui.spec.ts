// QA-280: /app/billing renders the success-fee note from the vertical's own
// config (previously hardcoded jets percentages in shared copy) and prices in
// the billing currency — machinery's 2%/1.5%/2% schedule must not inherit
// jets' "3% charter …" text.
import { expect, test } from '@playwright/test';
import { signUpAndLogin } from '../helpers/flow';

// Isolated rate-limit bucket per spec file — the dev server keeps
// buckets across the whole suite run (and across runs when reused), so
// shared 'local' IP logins exhaust ml:*/30ph mid-suite (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.5.7' } });

test('billing page shows config-derived fee note and plan price', async ({
  page,
}) => {
  // Swiss AirCharter is a seeded FREE-plan jets operator.
  await signUpAndLogin(page, 'fly@swissaircharter.example', 'operator');
  await page.goto('/app/billing');

  await expect(
    page.getByRole('heading', { name: 'Plan & billing' }),
  ).toBeVisible();
  // Jets fee schedule, derived from config — grouped by pct.
  await expect(
    page.getByText('3% Charter / Empty leg · 1.5% Aircraft for sale'),
  ).toBeVisible();
  // Billing currency is plans.pro.currency (USD) — same under machinery.
  await expect(page.getByText('$199')).toBeVisible();
  await expect(page.getByText('$0')).toBeVisible();
  // Free plan → upgrade control rendered, not the pro banner.
  await expect(page.getByTestId('pro-active')).toHaveCount(0);
});
