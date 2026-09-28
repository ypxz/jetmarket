// /search pagination: seeded pg has >24 active jets listings, so the pager
// must appear, page 2 must swap results, and filter params must survive
// navigation. See TESTIDS.md for the data-testid contract.
import { expect, test } from '@playwright/test';
import { signUpAndLogin } from '../helpers/flow';

test('search paginates results and keeps facet params across pages', async ({
  page,
}) => {
  await page.goto('/search');

  await expect(page.getByTestId('search-results-count')).toBeVisible();
  const pager = page.getByTestId('pager');
  await expect(pager).toBeVisible();
  await expect(pager).toContainText('Page 1 of');

  const firstCard = page.getByTestId('search-result').first();
  const firstTitle = await firstCard.textContent();
  await expect(page.getByTestId('search-result')).toHaveCount(24);

  await pager.getByRole('link', { name: 'Next' }).click();
  await expect(page).toHaveURL(/[?&]page=2/);
  await expect(pager).toContainText('Page 2 of');
  await expect(page.getByTestId('search-result').first()).not.toContainText(
    firstTitle ?? '',
  );

  // Facet params must survive page navigation (empty_leg seed exceeds one page).
  await page.getByTestId('facet-type').selectOption('empty_leg');
  await page.getByTestId('facet-apply').click();
  await expect(page).toHaveURL(/type=empty_leg/);
  await expect(page).not.toHaveURL(/[?&]page=/); // filtering resets to page 1
  const filteredPager = page.getByTestId('pager');
  if ((await filteredPager.count()) > 0) {
    await filteredPager.getByRole('link', { name: 'Next' }).click();
    await expect(page).toHaveURL(/type=empty_leg/);
    await expect(page).toHaveURL(/[?&]page=2/);
  }
});

// QA-178: sort select lives in the same GET form, so it composes with
// facets and persists through the pager.
test('search sorts by price and keeps the choice through facets', async ({
  page,
}) => {
  await page.goto('/search');
  const priceOf = async (i: number) => {
    const text = await page
      .getByTestId('search-result')
      .nth(i)
      .textContent();
    const m = /\$([\d,]+)/.exec(text ?? '');
    return m ? Number(m[1]!.replace(/,/g, '')) : NaN;
  };

  await page.getByTestId('facet-sort').selectOption('price_asc');
  await page.getByTestId('facet-apply').click();
  await expect(page).toHaveURL(/sort=price_asc/);
  const first = await priceOf(0);
  const last = await priceOf(
    (await page.getByTestId('search-result').count()) - 1,
  );
  expect(first).toBeLessThanOrEqual(last);

  await page.getByTestId('facet-sort').selectOption('price_desc');
  await page.getByTestId('facet-apply').click();
  await expect(page).toHaveURL(/sort=price_desc/);
  expect(await priceOf(0)).toBeGreaterThanOrEqual(await priceOf(1));
});

// QA-180: detail page renders a "similar listings" rail — same-type siblings,
// capped at 4, and never the listing itself.
test('listing page shows similar listings excluding itself', async ({
  page,
}) => {
  // Charter is the best-seeded type — guarantees same-type siblings.
  await page.goto('/search?type=charter');
  const card = page.getByTestId('listing-card').first();
  const href = await card.getAttribute('href');
  expect(href).toBeTruthy();
  await card.click();
  await expect(page).toHaveURL(/\/listing\//);

  const rail = page.getByTestId('similar-listings');
  await expect(rail).toBeVisible();
  const cards = rail.getByTestId('listing-card');
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(4);
  const hrefs = await cards.evaluateAll((els) =>
    els.map((el) => el.getAttribute('href')),
  );
  expect(hrefs).not.toContain(href);
});

// QA-215: jets "Leg date" date-range facet — the params <key>From/<key>To
// filter on the listing's `date` attribute; legs outside the window drop out.
test('search filters empty legs by leg-date range', async ({ page }) => {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const from = iso(new Date());
  const to = iso(new Date(Date.now() + 86_400_000));
  await page.goto(`/search?type=empty_leg&legDateFrom=${from}&legDateTo=${to}`);
  // pg seed keys empty-leg dates to today+offset; only offset-1 legs land in
  // [today, today+1] (LBG→NCE Challenger 650, NCE→ZRH Phenom 300).
  const cards = page.getByTestId('listing-card');
  await expect(cards).toHaveCount(2);
  await expect(page.getByText('NCE → ZRH empty leg')).toBeVisible();
  // A leg dated today+6 must not leak into the window.
  await expect(page.getByText('ZRH → LTN empty leg')).toHaveCount(0);
  // The sidebar's date inputs reflect the params so the form round-trips.
  await expect(page.getByTestId('facet-legDate-from')).toHaveValue(from);
  await expect(page.getByTestId('facet-legDate-to')).toHaveValue(to);
});

// QA-219: a leg that already flew is dead inventory — the seed's GVA→IBZ
// leg is dated yesterday and must not surface anywhere on public browse.
test('past-dated empty legs are hidden from public browse', async ({
  page,
  request,
}) => {
  // Unfiltered type browse — the whole empty_leg rail must exclude it.
  await page.goto('/search?type=empty_leg');
  await expect(page.getByText('GVA → IBZ empty leg')).toHaveCount(0);
  // Explicit airport facet reaching into the past doesn't resurrect it.
  await page.goto('/search?type=empty_leg&to=IBZ');
  await expect(page.getByText('GVA → IBZ empty leg')).toHaveCount(0);
  // Featured rail on the home page is also a browse surface.
  await page.goto('/');
  await expect(page.getByText('GVA → IBZ empty leg')).toHaveCount(0);

  // QA-220: a direct URL must 404 too — detail page, RFQ form, and the
  // listing API all treat a flown leg like a withdrawn listing.
  const gone = '00000000-0000-4000-8000-000000000248'; // the seeded past leg
  for (const path of [
    `/listing/${gone}`,
    `/rfq/${gone}`,
    `/api/listings/${gone}`,
  ]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
  }
});

// QA-217: a card opened from a filtered search carries the query — "Back to
// search" restores the buyer's filters instead of landing on bare /search.
test('listing back link restores the search filters', async ({ page }) => {
  await page.goto('/search?type=empty_leg&aircraftCategory=light');
  await page.getByTestId('listing-card').first().click();
  await expect(page).toHaveURL(/\/listing\//);
  await page.getByTestId('back-to-search').click();
  await expect(page).toHaveURL(/\/search\?/);
  await expect(page).toHaveURL(/type=empty_leg/);
  await expect(page).toHaveURL(/aircraftCategory=light/);
});

// QA-224: public browse hides expired legs, but the operator dashboard must
// say so — otherwise dead inventory reads "active" with no hint to relist.
// Alpine Jet owns the seeded flown GVA→IBZ leg.
test('operator dashboard flags expired listings as hidden', async ({
  page,
}) => {
  await signUpAndLogin(page, 'ops@alpinejet.example', 'operator');
  await page.goto('/app');
  await expect(
    page.getByText('expired — hidden from buyers'),
  ).toBeVisible();
});

// QA-225: delayed fan-out matches are invisible until due — the free-plan
// inbox must still surface them as an upsell, not silence. The pg seed gives
// Swiss AirCharter (free) one delayed match on the demo ZRH→NCE RFQ.
test('free operator inbox shows the delayed-RFQ teaser', async ({ page }) => {
  await signUpAndLogin(page, 'fly@swissaircharter.example', 'operator');
  await page.goto('/app/rfqs');
  await expect(page.getByTestId('delayed-rfq-teaser')).toBeVisible();
  await expect(page.getByTestId('delayed-rfq-teaser')).toContainText(
    '1 buyer request lands in your inbox in 24h',
  );
  // And the delayed RFQ itself stays out of the list until due.
  await expect(page.getByTestId('rfq-empty')).toBeVisible();
});

// QA-222: the similar-listings rail keeps the search context alive — its
// cards carry the same ?from, so a detour through a sibling still returns
// to the buyer's filtered search.
test('similar listings keep the search context in their links', async ({
  page,
}) => {
  await page.goto('/search?type=empty_leg&aircraftCategory=super_mid');
  await page.getByTestId('listing-card').first().click();
  await expect(page).toHaveURL(/\/listing\//);
  await expect(page.getByTestId('similar-listings')).toBeVisible();
  const similarLinks = page
    .getByTestId('similar-listings')
    .getByTestId('listing-card');
  const count = await similarLinks.count();
  expect(count).toBeGreaterThan(0); // non-vacuous: the rail has siblings
  for (let i = 0; i < count; i++) {
    await expect(similarLinks.nth(i)).toHaveAttribute(
      'href',
      /from=type%3Dempty_leg%26aircraftCategory%3Dsuper_mid/,
    );
  }
});

// QA-218: RFQ opened from an empty leg prefills route + leg date via the
// field's `prefillFrom` mapping; a charter (no from/to/date attrs) stays empty.
test('rfq form prefills route and leg date from the listing', async ({ page }) => {
  await page.goto('/search?type=empty_leg');
  await page.getByTestId('listing-card').first().click();
  await page.getByTestId('listing-rfq-cta').click();
  await expect(page).toHaveURL(/\/rfq\//);
  const departure = await page.getByTestId('rfq-field-departure').inputValue();
  const arrival = await page.getByTestId('rfq-field-arrival').inputValue();
  expect(departure).toMatch(/^[A-Z]{3}$/);
  expect(arrival).toMatch(/^[A-Z]{3}$/);
  const dateFrom = await page.getByTestId('rfq-field-dateFrom').inputValue();
  expect(dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // Both date bounds carry the same leg date — the buyer loosens if needed.
  await expect(page.getByTestId('rfq-field-dateTo')).toHaveValue(dateFrom);

  // Charter listings declare no from/to/date attributes → nothing prefilled.
  await page.goto('/search?type=charter');
  await page.getByTestId('listing-card').first().click();
  await page.getByTestId('listing-rfq-cta').click();
  await expect(page).toHaveURL(/\/rfq\//);
  await expect(page.getByTestId('rfq-field-departure')).toHaveValue('');
});
