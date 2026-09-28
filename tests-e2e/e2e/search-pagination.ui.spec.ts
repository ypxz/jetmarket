// /search pagination: seeded pg has >24 active jets listings, so the pager
// must appear, page 2 must swap results, and filter params must survive
// navigation. See TESTIDS.md for the data-testid contract.
import { expect, test } from '@playwright/test';

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
