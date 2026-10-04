// Core acceptance loop at UI level (spec §Acceptance), browser twin of
// e2e/core-loop.api.spec.ts. Runs against the data-testid hooks shipped by
// W3's public slice — see tests-e2e/TESTIDS.md for the contract.
import { expect, test } from '@playwright/test';
import postgres from 'postgres';
import {
  createListing,
  createOperatorProfile,
  isoDateIn,
  signUpAndLogin,
  step,
  tid,
  tidPrefix,
} from '../helpers/flow';

// Isolated rate-limit bucket per spec file — the dev server keeps
// buckets across the whole suite run (and across runs when reused), so
// shared 'local' IP logins exhaust ml:*/30ph mid-suite (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.8.7' } });

const run = Date.now();
const OPERATOR_EMAIL = `e2e-ui-operator-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-ui-buyer-${run}@jetmarket.local`;
const ADMIN_EMAIL = 'admin@jetmarket.local';
const LISTING_TITLE = `E2E UI Charter ${run}`;
// Unique per run — the shared dev repo accumulates deals across runs, so a
// fixed amount would collide with leftover ledger rows.
const QUOTE_AMOUNT = String(40000 + (run % 50000));
const QUOTE_AMOUNT_FMT = Number(QUOTE_AMOUNT).toLocaleString('en-US');
// 3% success fee on charters; the ledger renders whole dollars (formatMoney).
const EXPECTED_FEE = Math.round(Number(QUOTE_AMOUNT) * 0.03).toLocaleString('en-US');

test('core loop UI: signup → listings → search → RFQ → quote → accept → admin → upgrade', async ({
  browser,
}) => {
  test.setTimeout(300_000); // multi-actor flow on cold `next dev` compiles
  const operator = await browser.newPage();
  const buyer = await browser.newPage();
  const admin = await browser.newPage();

  await step('operator signs up via mock magic link', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E UI Ops ${run}`,
      baseAirport: 'LSZH',
    });
    // Free plan: analytics tiles are Pro-gated (QA-202).
    await operator.goto('/app');
    await expect(operator.getByTestId('stats-pro-gate')).toBeVisible();
    await expect(operator.getByTestId('operator-stats')).not.toBeVisible();
  });

  await step('operator creates 2 listings', async () => {
    await createListing(operator, {
      type: 'charter',
      title: LISTING_TITLE,
      price: '38000',
      fields: { aircraftCategory: 'light', model: 'Phenom 300', seats: '7', year: '2019', baseAirport: 'ZRH' },
    });
    await expect(operator).toHaveURL(/\/app/);
    await createListing(operator, {
      type: 'empty_leg',
      title: `E2E UI Empty Leg ${run}`,
      price: '9500',
      fields: { aircraftCategory: 'mid', model: 'Citation XLS', seats: '8', year: '2019', from: 'ZRH', to: 'NCE', date: isoDateIn(14) },
    });
    await expect(operator).toHaveURL(/\/app/);
  });

  await step('buyer searches with facets and sends RFQ', async () => {
    await buyer.goto('/search');
    await buyer.getByTestId('facet-q').fill(LISTING_TITLE);
    await buyer.getByTestId('facet-type').selectOption('charter');
    await buyer.getByTestId('facet-apply').click();
    // First search after boot may sit behind `next dev` cold-compiles —
    // give the results list longer than the default expect timeout.
    await expect(buyer.locator(tid('search-results'))).toContainText(LISTING_TITLE, {
      timeout: 30_000,
    });
    await buyer
      .getByTestId('search-result')
      .filter({ hasText: LISTING_TITLE })
      .first()
      .click();
    await expect(buyer).toHaveURL(/\/listing\//);
    await expect(buyer.getByTestId('listing-title')).toContainText(LISTING_TITLE);

    await buyer.getByTestId('listing-rfq-cta').click();
    // `next dev` can bounce client navigation while the rfq route is compiling;
    // retry the click once rather than flake on cold-compile timing.
    await buyer.waitForURL(/\/rfq\//, { timeout: 15_000 }).catch(async () => {
      await buyer.getByTestId('listing-rfq-cta').click();
      await buyer.waitForURL(/\/rfq\//, { timeout: 15_000 });
    });
    await buyer.getByTestId('rfq-field-departure').fill('ZRH');
    await expect(async () => {
      if (!buyer.url().includes('/rfq/thanks')) {
        // hydration can re-render inputs post-fill — refill inside the retry
        await buyer.getByTestId('rfq-field-arrival').fill('NCE');
        await buyer.getByTestId('rfq-field-dateFrom').fill(isoDateIn(14));
        await buyer.getByTestId('rfq-field-dateTo').fill(isoDateIn(15));
        await buyer.getByTestId('rfq-field-passengers').fill('4');
        await buyer.getByTestId('rfq-field-budgetUsd').fill('45000');
        await buyer.getByTestId('rfq-field-name').fill('E2E Buyer');
        await buyer.getByTestId('rfq-field-email').fill(BUYER_EMAIL);
        await buyer.getByTestId('rfq-submit').click();
      }
      // Wait on the redirect, not the element: under `next dev` cold-compile
      // /rfq/thanks can take several seconds to render, and element-first
      // asserts flake inside a short window (QA-144).
      await buyer.waitForURL(/\/rfq\/thanks/, { timeout: 12_000 });
      await expect(buyer.getByTestId('rfq-confirmation')).toBeVisible({
        timeout: 10_000,
      });
    }).toPass({ timeout: 40_000 });
    await expect(buyer.getByTestId('rfq-reference')).toBeVisible();
  });

  await step('operator dashboard shows per-listing RFQ demand', async () => {
    // QA-417: the listing that drew the RFQ chips "1 request" — demand
    // signal beside views/watchers, spam excluded server-side.
    await operator.goto('/app');
    const row = operator.locator('li').filter({ hasText: LISTING_TITLE });
    await expect(row.locator(tidPrefix('rfq-count-'))).toContainText('1 request');
    // The untouched second listing carries no chip.
    const quiet = operator.locator('li').filter({ hasText: 'E2E UI Empty Leg' });
    await expect(quiet.locator(tidPrefix('rfq-count-'))).toHaveCount(0);
    // QA-430: the chip deep-links to the per-listing inbox view — the
    // filtered list holds only this listing's RFQ and the select shows it.
    // This visit IS the first inbox render, so the mount effect stamps
    // inbox_seen_at here (not in the quote step below) — capture the POST.
    const [seenRes] = await Promise.all([
      operator.waitForResponse(
        (r) => r.url().includes('/api/operator/rfqs/seen') && r.request().method() === 'POST',
        { timeout: 20_000 },
      ),
      row.locator(tidPrefix('rfq-count-')).click(),
    ]);
    expect(seenRes.ok()).toBeTruthy();
    await operator.waitForURL(/\/app\/rfqs\?listing=/);
    const filtered = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    await expect(filtered).toBeVisible();
    // QA-416: a fresh arrival badges "New" on first render.
    await expect(filtered.locator(tidPrefix('rfq-new-'))).toBeVisible();
    await expect(operator.getByTestId('listing-filter')).toHaveValue(/./);
    // Back to the unfiltered inbox for the quote step — the clear chip
    // drops the listing scope (view links deliberately keep it).
    await operator.getByTestId('listing-filter-clear').click();
    await operator.waitForURL(/\/app\/rfqs$/);
  });

  await step('operator quotes the RFQ from the inbox', async () => {
    // QA-416: inbox_seen_at was stamped on the filtered visit above —
    // the badge is gone now and stays gone across a reload.
    await operator.goto('/app/rfqs');
    const item = operator.locator('li[data-testid^="rfq-"]').filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    await operator.reload();
    await expect(item.locator(tidPrefix('rfq-new-'))).toHaveCount(0);
    await item.locator(tidPrefix('quote-amount-')).fill(QUOTE_AMOUNT);
    await item.locator(tidPrefix('quote-send-')).click();
    await expect(item).toContainText(/quote sent|sent/i);

    // QA-433: the "Answered" view now holds this RFQ — it's the inverse of
    // "needs a quote", which must exclude it (and listing scope composes).
    await operator.getByTestId('filter-answered').click();
    await expect(operator).toHaveURL(/\/app\/rfqs\?f=answered/);
    await expect(
      operator.locator('li[data-testid^="rfq-"]').filter({ hasText: LISTING_TITLE }),
    ).toBeVisible();
    await operator.getByTestId('filter-needs').click();
    await expect(
      operator.locator('li[data-testid^="rfq-"]').filter({ hasText: LISTING_TITLE }),
    ).toHaveCount(0);
    await operator.getByTestId('filter-all').click();
    await expect(item).toBeVisible();
  });

  await step('operator dismisses a second RFQ — inbox-only, buyer unaffected (QA-420)', async () => {
    // Own fixture: a second, unquoted RFQ on the operator's empty-leg listing.
    // Inserted directly (UI RFQ flow already covered above) with its own
    // bearer token so the buyer side stays checkable.
    const sql = postgres(process.env.TEST_DATABASE_URL!);
    try {
      const [rfq] = await sql`
        insert into rfqs (vertical, listing_id, buyer_email, fields)
        select 'jets', l.id, ${BUYER_EMAIL}, ${sql.json({ from: 'ZRH', to: 'NCE', dateTo: isoDateIn(10) })}
        from listings l
        where l.title = ${`E2E UI Empty Leg ${run}`} and l.vertical = 'jets'
        returning id, access_token as "token"`;
      if (!rfq) throw new Error('empty-leg RFQ fixture insert failed');
      const other = await sql`
        select id from rfqs where id <> ${rfq.id} and listing_id in (
          select id from listings where title = ${LISTING_TITLE})`;
      await operator.goto('/app/rfqs');
      // The quoted charter row stays (dismiss only renders on unquoted rows);
      // the new unquoted empty-leg row offers dismiss.
      const charterRow = operator.locator(tid(`rfq-${other[0]!.id}`));
      await expect(charterRow).toBeVisible();
      await expect(charterRow.getByTestId(/^dismiss-rfq-/)).toHaveCount(0);
      const legRow = operator.locator(tid(`rfq-${rfq!.id}`));
      await expect(legRow).toBeVisible();
      await legRow.getByTestId(`dismiss-rfq-${rfq!.id}`).click();
      await expect(legRow).toHaveCount(0, { timeout: 15_000 });
      // Per-operator state persists across reloads.
      await operator.reload();
      await expect(operator.locator(tid(`rfq-${rfq!.id}`))).toHaveCount(0);
      // QA-421: the Dismissed view surfaces the row and Restore undoes it.
      await operator.goto('/app/rfqs?f=dismissed');
      const disRow = operator.locator(tid(`rfq-${rfq!.id}`));
      await expect(disRow).toBeVisible();
      await disRow.getByTestId(`restore-rfq-${rfq!.id}`).click();
      await expect(disRow).toHaveCount(0, { timeout: 15_000 });
      await operator.goto('/app/rfqs');
      await expect(operator.locator(tid(`rfq-${rfq!.id}`))).toBeVisible();
      // Dismiss it again — the buyer side is unaffected either way.
      await operator
        .locator(tid(`rfq-${rfq!.id}`))
        .getByTestId(`dismiss-rfq-${rfq!.id}`)
        .click();
      await expect(operator.locator(tid(`rfq-${rfq!.id}`))).toHaveCount(0, {
        timeout: 15_000,
      });
      const inbox = await buyer.request.get(
        `/api/buyer/quotes?email=${encodeURIComponent(BUYER_EMAIL)}`,
        { headers: { 'x-rfq-token': rfq!.token } },
      );
      const rows = (await inbox.json()) as { id: string }[];
      expect(rows.map((r) => r.id)).toContain(rfq!.id);
      await sql`delete from rfqs where id = ${rfq!.id}`;
    } finally {
      await sql.end();
    }
  });

  await step('operator dashboard shows the live offer pipeline (QA-424)', async () => {
    await operator.goto('/app');
    const section = operator.getByTestId('operator-open-offers');
    await expect(section).toBeVisible();
    await expect(section).toContainText('Open offers (1)');
    const row = section.locator(tidPrefix('open-offer-'));
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(QUOTE_AMOUNT_FMT);
    await expect(row).toContainText(LISTING_TITLE);
    // The CTA lands back on the RFQ inbox where the live offer sits.
    await row.getByRole('link').click();
    await expect(operator).toHaveURL(/\/app\/rfqs/);
  });

  await step('buyer accepts the quote', async () => {
    // the thanks page's 'view quotes' link carries the per-RFQ bearer token (QA-39)
    await buyer.getByTestId('rfq-view-quotes').click();
    const emailInput = buyer.getByTestId('buyer-email');
    if (!(await emailInput.inputValue())) await emailInput.fill(BUYER_EMAIL);
    await buyer.getByTestId('buyer-load').click();
    // amount renders grouped, e.g. "USD 41,000"
    const quote = buyer
      .locator(tidPrefix('quote-'))
      .filter({ hasText: QUOTE_AMOUNT_FMT });
    await expect(quote).toBeVisible();
    await quote.locator(tidPrefix('accept-')).click();
    await expect(buyer.getByTestId('accept-msg')).toContainText(/deal|closed/i);
  });

  await step('admin fee ledger shows the deal and fee invoice', async () => {
    await signUpAndLogin(admin, ADMIN_EMAIL);
    await admin.goto('/admin');
    const ledger = admin.getByTestId('fee-ledger');
    await expect(ledger).toBeVisible();
    await expect(ledger.locator(tidPrefix('deal-')).filter({ hasText: EXPECTED_FEE })).toBeVisible();
  });

  await step('operator dashboard surfaces the closed deal and fee state', async () => {
    await operator.goto('/app');
    const deals = operator.getByTestId('operator-deals');
    await expect(deals).toBeVisible();
    await expect(deals.filter({ hasText: EXPECTED_FEE })).toBeVisible();
    await expect(deals.getByText('invoiced')).toBeVisible();
    // QA-428: the closed deal unlocks buyer contact + listing context.
    await expect(deals.filter({ hasText: BUYER_EMAIL })).toBeVisible();
    await expect(deals.filter({ hasText: LISTING_TITLE })).toBeVisible();
  });

  await step('buyer sees the operator track record (QA-431)', async () => {
    // One closed deal now exists — the quotes API's dealsClosed and the
    // public profile badge must agree on it.
    const sql = postgres(process.env.TEST_DATABASE_URL!);
    try {
      const [rfq] = await sql<
        { id: string; token: string }[]
      >`select id, access_token as "token" from rfqs where listing_id in (
          select id from listings where title = ${LISTING_TITLE}) and vertical = 'jets'
          order by created_at limit 1`;
      const inbox = await buyer.request.get(
        `/api/buyer/quotes?email=${encodeURIComponent(BUYER_EMAIL)}`,
        { headers: { 'x-rfq-token': rfq!.token } },
      );
      const rows = (await inbox.json()) as {
        id: string;
        quotes: { operator: { dealsClosed?: number } | null }[];
      }[];
      const row = rows.find((r) => r.id === rfq!.id);
      expect(row?.quotes[0]?.operator?.dealsClosed).toBe(1);

      const [op] = await sql<{ id: string }[]>`
        select o.id from operators o
        join users u on u.id = o.user_id
        where u.email = ${OPERATOR_EMAIL}`;
      await buyer.goto(`/operators/${op!.id}`);
      await expect(buyer.getByTestId('operator-deals-count')).toHaveText(
        '1 deal closed',
      );
      await expect(
        buyer.getByTestId('operator-member-since'),
      ).toContainText('since');
      // QA-434: the quote went out seconds after submit — "~1 hour".
      await expect(
        buyer.getByTestId('operator-response-time'),
      ).toContainText('~1 hour');
    } finally {
      await sql.end();
    }
  });

  await step('free limit → upgrade via mock checkout → limit lifted', async () => {
    // third listing still allowed (free = 3)
    await createListing(operator, {
      type: 'charter',
      title: `E2E UI Third ${run}`,
      price: '30000',
      fields: { aircraftCategory: 'mid', model: 'G280', seats: '9', year: '2019', baseAirport: 'ZRH' },
    });
    // fourth is rejected: 402 surfaces the upgrade CTA on the form
    await createListing(operator, {
      type: 'charter',
      title: `E2E UI Fourth ${run}`,
      price: '31000',
      fields: { aircraftCategory: 'mid', model: 'G280', seats: '9', year: '2019', baseAirport: 'ZRH' },
    });
    await expect(operator.getByTestId('upgrade-cta')).toBeVisible();

    await operator.getByTestId('upgrade-cta').click();
    await operator.getByTestId('checkout-pro').click();
    // Mock checkout routes to ?checkout=success — banner pins QA-203.
    await expect(operator.getByTestId('checkout-success')).toBeVisible();
    await expect(operator.getByTestId('pro-active')).toBeVisible();
    // Pro unlocks the funnel tiles (QA-202) + rolling-30d line (QA-208).
    await operator.goto('/app');
    await expect(operator.getByTestId('operator-stats')).toBeVisible();
    await expect(operator.getByTestId('stats-recent')).toContainText(
      'Last 30 days',
    );

    await createListing(operator, {
      type: 'charter',
      title: `E2E UI Post-Upgrade ${run}`,
      price: '31000',
      fields: { aircraftCategory: 'mid', model: 'G280', seats: '9', year: '2019', baseAirport: 'ZRH' },
    });
    await expect(operator).toHaveURL(/\/app/);
  });
});
