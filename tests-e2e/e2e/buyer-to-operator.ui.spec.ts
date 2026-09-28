// QA-267: a buyer-role account can become an operator through the UI. The
// sign-in role radio only applies at account creation, so this user signs in
// as `buyer` — /app must still render the become-operator CTA (the (app)
// layout used to bounce non-operators to /sign-in) and the onboarding POST
// promotes the role.
import { expect, test } from '@playwright/test';
import { signUpAndLogin, step } from '../helpers/flow';

const run = Date.now().toString(36);
const BUYER_EMAIL = `e2e-ui-b2o-${run}@jetmarket.local`;

test('buyer sign-in can reach onboarding and becomes an operator', async ({
  page,
}) => {
  test.setTimeout(180_000);

  await step('buyer signs in via the buyer radio', async () => {
    await signUpAndLogin(page, BUYER_EMAIL, 'buyer');
  });

  await step('/app shows the become-operator CTA instead of bouncing', async () => {
    // The real path: the Operator nav link is visible to buyers too (QA-267 —
    // it used to render only for operator/admin).
    await page.goto('/');
    await page.locator('nav').getByRole('link', { name: 'Operator' }).click();
    await expect(page.getByTestId('onboarding-cta')).toBeVisible();
  });

  await step('onboarding promotes the account to operator', async () => {
    await page.getByTestId('onboarding-cta').click();
    await page.getByTestId('operator-name-input').fill(`B2O Ops ${run}`);
    await page.getByTestId('operator-base-input').fill('LSGG');
    await page.getByTestId('operator-save').click();
    // Post-submit the same session lands on the operator dashboard — the
    // promotion is effective immediately (role is re-read per request).
    await expect(page.getByTestId('operator-name')).toBeVisible();
  });
});
