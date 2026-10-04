// QA-495: user-visible API errors carry a stable `code` (slug of the English
// message) that client surfaces map through the errors.* catalog — a /de
// submit flashes German, not the raw English string.
import { expect, test } from '@playwright/test';
import { fillRfqForm, step } from '../helpers/flow';

test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.15.9' } });

const run = Date.now().toString(36);

test('api errors carry a slugged code the /de UI renders as German', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  await step('envelope: error responses carry code + English fallback text', async () => {
    const res = await request.post('/api/rfqs', {
      data: { listingId: 'nope', buyerEmail: 'not-an-email' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.error).toBeTruthy();
    expect(body.code).toMatch(/^[a-z0-9_]+$/);
  });

  await step('/de rfq form: a 422 renders the German catalog string', async () => {
    // A seeded listing keeps this leg light — find one via the public list.
    const list = await request.get('/api/listings?limit=1');
    const listings = (await list.json()) as { id: string }[];
    await page.goto(`/de/rfq/${listings[0]!.id}`);
    await fillRfqForm(page, `e2e-err-buyer-${run}@jetmarket.local`);
    // Clear a required text field AND drop its required attr so the browser's
    // native validation doesn't swallow the submit before fetch fires.
    const field = page
      .locator('form [data-testid^="rfq-field-"][type="text"], form [data-testid^="rfq-field-"]:not([type])')
      .first();
    await field.evaluate((el) => {
      el.removeAttribute('required');
      (el as HTMLInputElement).value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const res = page.waitForResponse(
      (r) =>
        r.url().includes('/api/rfqs') &&
        r.request().method() === 'POST' &&
        r.status() === 422,
    );
    await page.getByTestId('rfq-submit').click();
    await res;
    const alert = page.getByTestId('rfq-error');
    await expect(alert).toBeVisible();
    // de catalog: 'invalid_fields' — NOT the English "invalid fields".
    await expect(alert).toContainText(/ungültig|Ungültige/i);
    await expect(alert).not.toContainText(/invalid fields/i);
  });
});
