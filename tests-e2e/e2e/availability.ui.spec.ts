// Operator away switch (QA-427): the dashboard toggle flips
// accepting_rfqs; the away banner renders server-side and persists
// across reloads. Fan-out exclusion itself is pinned at the repo seam
// (worker integration) and the memory-mode unit suite.
import { expect, test } from '@playwright/test';
import { createOperatorProfile, signUpAndLogin, step } from '../helpers/flow';

// Isolated rate-limit bucket per spec file (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.19.7' } });

const run = Date.now();
const OPERATOR_EMAIL = `e2e-ui-away-${run}@jetmarket.local`;

test('availability toggle: pause shows banner, persists, resume clears', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const operator = await browser.newPage();

  await step('operator signs up and creates a profile', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E Away Ops ${run}`,
      baseAirport: 'LSZH',
    });
  });

  await step('pause hides them from new fan-outs', async () => {
    await operator.goto('/app');
    await expect(
      operator.getByTestId('availability-toggle'),
    ).toHaveText('Pause new requests');
    await operator.getByTestId('availability-toggle').click();
    await expect(operator.getByTestId('away-banner')).toBeVisible();
    await expect(
      operator.getByTestId('availability-toggle'),
    ).toHaveText('Resume new requests');
  });

  await step('the flag survives a reload (server-rendered)', async () => {
    await operator.reload();
    await expect(operator.getByTestId('away-banner')).toBeVisible();
    await expect(
      operator.getByTestId('availability-toggle'),
    ).toHaveText('Resume new requests');
  });

  await step('resume clears the banner', async () => {
    await operator.getByTestId('availability-toggle').click();
    await expect(operator.getByTestId('away-banner')).not.toBeVisible();
    await expect(
      operator.getByTestId('availability-toggle'),
    ).toHaveText('Pause new requests');
  });
});
