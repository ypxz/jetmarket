// Actor-level helpers for the UI specs. Locators follow the data-testid
// contract in tests-e2e/TESTIDS.md — keep the two in sync.
import { expect, test, type Page } from '@playwright/test';
import { waitForEmailLink } from './outbox';

export const tid = (name: string) => `[data-testid="${name}"]`;
/** Prefix matcher for id-suffixed testids like rfq-<id>, quote-<id>. */
export const tidPrefix = (name: string) => `[data-testid^="${name}"]`;

/** ISO date `days` from today — fixtures must stay in the future or the
 *  expiry sweep / browse-expiry gate treats them as dead (QA-360). */
export const isoDateIn = (days: number, from = new Date()) =>
  new Date(from.getTime() + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Sign in via the mock magic link. In mock mode POST /api/auth/magic-link
 * returns `devLink` (also rendered on /sign-in as data-testid="signin-devlink")
 * and emails the link via the mock outbox — this helper prefers the on-page
 * devlink and falls back to the emailed link.
 */
export async function signUpAndLogin(
  page: Page,
  email: string,
  role: 'buyer' | 'operator' | 'admin' = 'buyer',
) {
  await page.goto('/sign-in');
  // `next dev` Fast Refresh can remount the page mid-fill (runtime error in
  // another route's compile clears inputs) — refill before each attempt and
  // retry the POST once instead of trusting the first fill.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByTestId('signin-email').fill(email);
    if (role !== 'buyer') {
      const radio = page.getByTestId(`signin-role-${role}`);
      await radio.check();
      await expect(radio).toBeChecked();
    }
    const posted = page
      .waitForResponse(
        (r) => r.url().includes('/api/auth/magic-link') && r.request().method() === 'POST',
        { timeout: 60_000 }, // generous: cold `next dev` compiles can stall the POST
      )
      .then(() => true)
      .catch(() => false);
    await page.getByTestId('signin-submit').click();
    if (await posted) break;
    if (attempt === 1) throw new Error('magic-link POST never fired after 2 attempts');
    await page.goto('/sign-in'); // fresh mount before the retry
  }
  const devLink = page.getByTestId('signin-devlink');
  if (await devLink.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await devLink.click();
  } else {
    await page.goto(await waitForEmailLink(email));
  }
  // GET only verifies — the session cookie is set by posting the confirm
  // form (magic links survive mail-scanner prefetch this way).
  await page.getByTestId('confirm-signin').click();
}

export async function createOperatorProfile(
  page: Page,
  { name, baseAirport }: { name: string; baseAirport: string },
) {
  await page.goto('/app');
  await page.getByTestId('onboarding-cta').click();
  await page.getByTestId('operator-name-input').fill(name);
  await page.getByTestId('operator-base-input').fill(baseAirport);
  await page.getByTestId('operator-save').click();
  await expect(page.getByTestId('operator-name')).toBeVisible();
}

export interface ListingInput {
  type: string; // listing type slug from the vertical config
  title: string;
  price: string;
  /** attribute key -> value; filled into inputs named/data-testid'd per TESTIDS.md */
  fields?: Record<string, string>;
}

export async function createListing(page: Page, input: ListingInput) {
  await page.goto('/app/listings/new');
  const typeSelect = page.getByTestId('listing-type');
  if (await typeSelect.count()) {
    await typeSelect
      .selectOption(input.type, { timeout: 4_000 })
      .catch(() => typeSelect.selectOption({ index: 1 }, { timeout: 4_000 }).catch(() => {}));
  }
  await page.getByTestId('listing-title').fill(input.title);
  // The dynamic fields render only after GET /api/vertical lands — wait for
  // the first requested key before filling so fast dev compiles don't leave
  // attributes {} (the previous fill-then-render race dropped every field).
  const firstKey = Object.keys(input.fields ?? {})[0];
  if (firstKey) {
    await page
      .getByTestId(`listing-${firstKey}`)
      .or(page.getByTestId(`field-${firstKey}`))
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => {});
  }
  await fillDynamicFields(page, input.fields ?? {});
  await page.getByTestId('listing-price').fill(input.price);
  // Cold-compile body drop (AGENTS.md): a first-hit POST to an
  // on-demand-compiled route can lose its body — warm /api/listings so the
  // save POST never pays the compile tax (QA-529 follow-up: upload.ui).
  await page.request.get('/api/listings').catch(() => {});
  await page.getByTestId('listing-save').click();
}

/**
 * Fill dynamic attribute inputs inside the listing/RFQ form. Knows the merged
 * jets fields (listing-category/model/seats/from/to/date) and falls back to
 * filling remaining visible required inputs — placeholder-taxonomy safe for
 * machinery where field keys differ.
 */
export async function fillDynamicFields(page: Page, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    const el = page.getByTestId(`listing-${key}`).or(page.getByTestId(`field-${key}`));
    if ((await el.count()) === 0) continue;
    const tag = await el.evaluate((n) => n.tagName.toLowerCase());
    if (tag === 'select') {
      await el.selectOption(value, { timeout: 4_000 }).catch(() =>
        el.selectOption({ label: value }, { timeout: 4_000 }).catch(() =>
          el.selectOption({ index: 1 }, { timeout: 4_000 }).catch(() => {})));
    } else {
      await el.fill(value);
    }
  }
  // Fallback: fill any still-empty required inputs in the form.
  const required = page.locator('form [required]');
  for (const el of await required.all()) {
    const type = await el.getAttribute('type');
    const tag = await el.evaluate((n) => n.tagName.toLowerCase());
    if (tag === 'select') {
      if (!(await el.inputValue())) await el.selectOption({ index: 1 }, { timeout: 4_000 }).catch(() => {});
      continue;
    }
    if (await el.inputValue()) continue;
    if (type === 'number') await el.fill('4');
    else if (type === 'date') await el.fill(isoDateIn(14));
    else if (type === 'email') await el.fill('e2e@jetmarket.local');
    else await el.fill('e2e');
  }
}

/**
 * Fill every rfq-field-* control in the RFQ form, generically by input type.
 * Field keys come from the vertical's rfqFields config, so this works for jets
 * (departure/arrival/passengers/…) and machinery (deliveryPostcode/…)
 * without hardcoding keys. `email` fills the email-typed field.
 */
export async function fillRfqForm(page: Page, email: string) {
  // Wait for the form itself: after listing-rfq-cta client-nav the rfq page can
  // still be compiling — without this the loop finds 0 controls and submits an
  // empty form, hitting native required-field validation.
  await page.getByTestId('rfq-form').waitFor();
  const controls = page.locator('form [data-testid^="rfq-field-"]');
  for (const el of await controls.all()) {
    const tag = await el.evaluate((n) => n.tagName.toLowerCase());
    if (tag === 'select') {
      await el.selectOption({ index: 1 }).catch(() => {});
      continue;
    }
    const type = await el.getAttribute('type');
    if (type === 'email') await el.fill(email);
    else if (type === 'tel') await el.fill('+41 79 000 00 00');
    else if (type === 'number') await el.fill('4');
    else if (type === 'date') await el.fill(isoDateIn(14));
    else if (tag === 'textarea') await el.fill('e2e notes');
    else await el.fill('e2e');
  }
}

export const step = (name: string, fn: () => Promise<void>) => test.step(name, fn);
