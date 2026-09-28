// Demo-link UI pin (QA-279): the seeded demo-buyer URL —
// /quotes?email=charter@geneva-pe.example#t=demo-buyer-token — is the first
// thing an evaluator opens. Drive it in a real browser: the page must read
// the #t= fragment, forward it as x-rfq-token, strip it from the address
// bar, and render the payable $14,500 quote with accept/decline controls.
// Read-only: does NOT click accept — the seeded fixture must stay payable
// for every later check of the same demo path.
import { expect, test, type Page } from '@playwright/test';

// Isolated rate-limit bucket per spec file — the dev server keeps
// buckets across the whole suite run (and across runs when reused), so
// shared 'local' IP logins exhaust ml:*/30ph mid-suite (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.10.7' } });

const DEMO_RFQ_ID = '00000000-0000-4000-8000-000000000300';
const DEMO_URL =
  '/en/quotes?email=charter%40geneva-pe.example#t=demo-buyer-token';

test('demo link renders the seeded quote without leaking the token', async ({
  page,
}) => {
  await page.goto(DEMO_URL);

  const rfq = page.getByTestId(`buyer-rfq-${DEMO_RFQ_ID}`);
  await expect(rfq).toBeVisible();
  // state badge + live quote row
  await expect(page.getByTestId(`rfq-state-${DEMO_RFQ_ID}`)).toContainText(
    /quot/i,
  );
  const quote = rfq.locator('[data-testid^="quote-"]');
  await expect(quote).toHaveCount(1);
  await expect(quote.first()).toContainText(/14[,.]500/);
  await expect(rfq.locator('[data-testid^="accept-"]')).toBeVisible();
  await expect(rfq.locator('[data-testid^="decline-"]')).toBeVisible();
  // buyer's own request fields echoed, contact keys absent (QA-241)
  const echo = page.getByTestId(`rfq-echo-${DEMO_RFQ_ID}`);
  await expect(echo).toContainText(/ZRH/);
  await expect(echo).toContainText(/NCE/);
  await expect(echo).not.toContainText(/@/);

  // The bearer token must not linger in the address bar / history (QA-240).
  await expect.poll(() => page.url()).not.toContain('t=');
  await expect.poll(() => page.url()).not.toContain('demo-buyer-token');
});
