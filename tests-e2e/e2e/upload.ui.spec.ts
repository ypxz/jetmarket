// Photo upload flow, browser-level (QA-321): the listing form's file input
// POSTs each file to /api/uploads, stores the returned key on the listing,
// and the public listing page serves it back via /storage/<key>. Exercises
// the whole path — auth + MIME allowlist + provider write + public GET —
// that the route's unit tests can't cover together.
import { expect, test } from '@playwright/test';
import {
  createOperatorProfile,
  fillDynamicFields,
  signUpAndLogin,
  step,
} from '../helpers/flow';

// Isolated rate-limit bucket per spec file (see core-loop.ui.spec.ts / QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.8.9' } });

const run = Date.now();
const OPERATOR_EMAIL = `e2e-ui-upload-${run}@jetmarket.local`;
const TITLE = `E2E Upload Charter ${run}`;

// 1x1 transparent PNG — real bytes so the storage provider round-trips.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('photo upload: file input → storage key → served on public listing', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const operator = await browser.newPage();

  await step('operator signs up and creates a profile', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E Upload Ops ${run}`,
      baseAirport: 'LSZH',
    });
  });

  await step('listing created with one photo', async () => {
    await operator.goto('/app/listings/new');
    const typeSelect = operator.getByTestId('listing-type');
    if (await typeSelect.count()) {
      await typeSelect
        .selectOption('charter', { timeout: 4_000 })
        .catch(() => typeSelect.selectOption({ index: 1 }, { timeout: 4_000 }).catch(() => {}));
    }
    await operator.getByTestId('listing-title').fill(TITLE);
    // Same cold-compile wait as helpers.createListing: the dynamic fields
    // render only after GET /api/vertical lands.
    await operator
      .getByTestId('listing-aircraftCategory')
      .or(operator.getByTestId('field-aircraftCategory'))
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => {});
    await fillDynamicFields(operator, {
      aircraftCategory: 'light',
      model: 'Phenom 300',
      seats: '7',
      year: '2019',
      baseAirport: 'ZRH',
    });
    await operator.getByTestId('listing-price').fill('38000');
    await operator.getByTestId('listing-photos').setInputFiles({
      name: 'e2e-photo.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await operator.getByTestId('listing-save').click();
    await expect(operator).toHaveURL(/\/app(\/listings)?\/?$/, { timeout: 30_000 });
  });

  await step('uploaded photo renders and serves 200 on the public page', async () => {
    // Resolve the new listing's id through the public search API (title is
    // run-unique).
    const res = await operator.request.get(
      `/api/listings?q=${encodeURIComponent(TITLE)}`,
    );
    expect(res.ok()).toBeTruthy();
    const created = ((await res.json()) as Array<{ id: string; title: string; photos: string[] }>).find(
      (l) => l.title === TITLE,
    );
    expect(created).toBeTruthy();
    expect(created!.photos).toHaveLength(1);
    expect(created!.photos[0]).toMatch(/^uploads\/.+\.png$/);

    await operator.goto(`/listing/${created!.id}`);
    const img = operator.getByTestId('gallery-photo-0');
    await expect(img).toBeVisible({ timeout: 15_000 });
    const src = await img.getAttribute('src');
    expect(src).toBeTruthy();
    expect(src!).toContain(created!.photos[0]);

    const imgRes = await operator.request.get(src!);
    expect(imgRes.status()).toBe(200);
    expect(imgRes.headers()['content-type']).toBe('image/png');
  });
});
