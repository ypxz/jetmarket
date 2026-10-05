// Admin pages in a real browser (QA-286): /admin + /admin/jobs had only
// API-level coverage — a render-time break (bad testid, missing key,
// layout crash) was invisible. Also pins the non-admin redirect.
import { expect, test } from '@playwright/test';
import { signUpAndLogin } from '../helpers/flow';

// Isolated rate-limit bucket per spec file — the dev server keeps
// buckets across the whole suite run (and across runs when reused), so
// shared 'local' IP logins exhaust ml:*/30ph mid-suite (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.3.7' } });

const run = Date.now();

test('admin dashboard + jobs render and verify toggles', async ({ page }) => {
  test.setTimeout(90_000);

  // Seeded admin identity — ADMIN_EMAILS promotes this address at sign-in.
  await signUpAndLogin(page, `e2e-admin-x${run}@jetmarket.local`);
  await page.goto('/admin');
  await expect(
    page.getByRole('heading', { name: 'Admin', level: 1 }),
  ).toBeVisible();
  // All four panels render: operators, fee ledger, listing mod, rfq mod.
  await expect(page.locator('[data-testid^="admin-op-"]').first()).toBeVisible();
  await expect(page.getByTestId('fee-ledger')).toBeVisible();

  // Verify-toggle round-trip: the operator table shows names not emails,
  // so take the first seeded row and assert its cell flips then restores.
  const firstOpRow = page.locator('[data-testid^="admin-op-"]').first();
  const opId = (await firstOpRow.getAttribute('data-testid'))!.replace(
    'admin-op-',
    '',
  );
  const cell = page.getByTestId(`admin-verified-${opId}`);
  const before = (await cell.textContent())?.trim();
  await page.getByTestId(`verify-${opId}`).click();
  await expect(cell).not.toHaveText(before ?? '');
  // flip back so the seed state is preserved for other specs
  await page.getByTestId(`verify-${opId}`).click();
  await expect(cell).toHaveText(before ?? '');

  // QA-552: the operator name links into the drill-down card; "← all
  // operators" returns to the plain dashboard.
  await page.getByTestId(`op-view-${opId}`).click();
  await expect(page.getByTestId('op-detail')).toBeVisible();
  await expect(page.getByTestId('op-detail-meta')).toContainText('@');
  await expect(page.getByTestId('op-detail-book')).toContainText('Book:');
  await expect(page.getByTestId('op-detail-flags')).toContainText('Open flags:');
  await page.getByText('← all operators').click();
  await expect(page.getByTestId('op-detail')).toBeHidden();

  // Jobs page renders — rows or the documented empty state.
  await page.goto('/admin/jobs');
  await expect(
    page.getByRole('heading', { name: 'Job queue', level: 1 }),
  ).toBeVisible();
});

test('non-admin is redirected away from /admin', async ({ page }) => {
  await signUpAndLogin(page, `e2e-adminui-buyer-${run}@jetmarket.local`, 'buyer');
  await page.goto('/admin');
  await expect(page).toHaveURL(/sign-in/);
});
