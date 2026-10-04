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
// QA-439: the operator sharpens their price before the buyer decides —
// every downstream amount/fee assertion runs on the revised figure.
const REVISED_AMOUNT = String(Number(QUOTE_AMOUNT) - 377);
const REVISED_AMOUNT_FMT = Number(REVISED_AMOUNT).toLocaleString('en-US');
// 3% success fee on charters; the ledger renders whole dollars (formatMoney).
const EXPECTED_FEE = Math.round(Number(REVISED_AMOUNT) * 0.03).toLocaleString('en-US');

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
    // QA-442: live rows carry the request deadline — this RFQ is dated
    // (dateTo in 15d), so replies close at the next UTC midnight.
    await expect(
      item.locator('[data-testid^="rfq-deadline-"]'),
    ).toContainText(/replies close/i);
    // QA-443: the "Ending first" sort toggle is offered beside the views;
    // it flips ?sort=deadline while keeping the inbox usable.
    await operator.getByTestId('sort-ending').click();
    await expect(operator).toHaveURL(/\/app\/rfqs\?sort=deadline/);
    await expect(
      operator.locator('li[data-testid^="rfq-"]').filter({ hasText: LISTING_TITLE }),
    ).toBeVisible();
    await operator.getByTestId('sort-ending').click();
    await expect(operator).toHaveURL(/\/app\/rfqs$/);

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

  await step('operator revises the sent quote — buyer sees the new terms (QA-439)', async () => {
    // Fat-finger guard: the offer sharpens in place instead of a
    // withdraw+lose detour; the CAS keeps 'sent' under a racing accept.
    await operator.goto('/app/rfqs');
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    const qrow = item.locator('[data-testid^="op-quote-"]');
    await qrow.locator('[data-testid^="revise-"]').click();
    await item.locator('[data-testid^="revise-amount-"]').fill(REVISED_AMOUNT);
    await item.locator('[data-testid^="revise-message-"]').fill('sharpened');
    await item.locator('[data-testid^="revise-save-"]').click();
    await expect(qrow).toContainText(REVISED_AMOUNT_FMT, { timeout: 15_000 });
    // The buyer side reflects the revision immediately (page + email).
    const sql = postgres(process.env.TEST_DATABASE_URL!);
    try {
      const [tok] = await sql`
        select access_token as "token" from rfqs
        where buyer_email = ${BUYER_EMAIL} limit 1`;
      const res = await buyer.request.get(
        `/api/buyer/quotes?email=${encodeURIComponent(BUYER_EMAIL)}`,
        { headers: { 'x-rfq-token': tok!.token } },
      );
      const rfqs = (await res.json()) as { quotes: { amount: number }[] }[];
      const amounts = rfqs.flatMap((r) => r.quotes.map((q) => q.amount));
      expect(amounts).toContain(Number(REVISED_AMOUNT));
    } finally {
      await sql.end();
    }
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
      // QA-438: a second unquoted RFQ makes "Dismiss all (2)" appear — one
      // click sweeps every dismissable row (the quoted charter row can't be
      // dismissed and is untouched).
      const [rfq2] = await sql`
        insert into rfqs (vertical, listing_id, buyer_email, fields)
        select 'jets', l.id, ${`e2e-bulk-${run}@jetmarket.local`}, ${sql.json({ from: 'ZRH', to: 'NCE', dateTo: isoDateIn(10) })}
        from listings l
        where l.title = ${`E2E UI Empty Leg ${run}`} and l.vertical = 'jets'
        returning id`;
      if (!rfq2) throw new Error('bulk-dismiss fixture insert failed');
      await operator.goto('/app/rfqs');
      await expect(operator.getByTestId('dismiss-all')).toBeVisible();
      operator.once('dialog', (d) => void d.accept());
      await operator.getByTestId('dismiss-all').click();
      await expect(operator.locator(tid(`rfq-${rfq!.id}`))).toHaveCount(0, {
        timeout: 15_000,
      });
      await expect(operator.locator(tid(`rfq-${rfq2!.id}`))).toHaveCount(0);
      await expect(operator.locator(tid(`rfq-${other[0]!.id}`))).toBeVisible();
      await operator.goto('/app/rfqs?f=dismissed');
      await expect(operator.locator(tid(`rfq-${rfq!.id}`))).toBeVisible();
      await expect(operator.locator(tid(`rfq-${rfq2!.id}`))).toBeVisible();
      // QA-440: the bulk sweep has a bulk undo — Restore all on the
      // dismissed view returns every row to the live inbox in one click.
      await operator.getByTestId('restore-all').click();
      await expect(operator.locator(tid(`rfq-${rfq!.id}`))).toHaveCount(0, {
        timeout: 15_000,
      });
      await expect(operator.locator(tid(`rfq-${rfq2!.id}`))).toHaveCount(0);
      await operator.goto('/app/rfqs');
      await expect(operator.locator(tid(`rfq-${rfq!.id}`))).toBeVisible();
      await expect(operator.locator(tid(`rfq-${rfq2!.id}`))).toBeVisible();
      const inbox = await buyer.request.get(
        `/api/buyer/quotes?email=${encodeURIComponent(BUYER_EMAIL)}`,
        { headers: { 'x-rfq-token': rfq!.token } },
      );
      const rows = (await inbox.json()) as { id: string }[];
      expect(rows.map((r) => r.id)).toContain(rfq!.id);
      await sql`delete from rfqs where id in (${rfq!.id}, ${rfq2!.id})`;
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
    await expect(row).toContainText(REVISED_AMOUNT_FMT);
    await expect(row).toContainText(LISTING_TITLE);
    // QA-444: the offer row names the request's close date — an offer
    // dies with its request, so the pipeline shows the horizon.
    await expect(
      row.locator('[data-testid^="offer-deadline-"]'),
    ).toContainText(/request closes/i);
    // The CTA lands back on the RFQ inbox where the live offer sits.
    await row.getByRole('link').click();
    await expect(operator).toHaveURL(/\/app\/rfqs/);
  });

  await step('buyer accepts the quote', async () => {
    // QA-446: pull the live RFQ's close date in to ~4 days so the Extend
    // button has something to buy — extending in place beats the QA-410
    // repost twin (quotes + delivered-to history survive).
    const sqlx = postgres(process.env.TEST_DATABASE_URL!);
    let extRfqId = '';
    try {
      const [ext] = await sqlx`
        update rfqs set fields = fields || ${sqlx.json({ dateTo: isoDateIn(3) })}::jsonb
        where buyer_email = ${BUYER_EMAIL} and status in ('new','matched','quoted')
        returning id`;
      extRfqId = ext!.id;
    } finally {
      await sqlx.end();
    }
    // the thanks page's 'view quotes' link carries the per-RFQ bearer token (QA-39)
    await buyer.getByTestId('rfq-view-quotes').click();
    const emailInput = buyer.getByTestId('buyer-email');
    if (!(await emailInput.inputValue())) await emailInput.fill(BUYER_EMAIL);
    await buyer.getByTestId('buyer-load').click();
    // QA-442: the buyer sees the same close date the operator inbox shows.
    await expect(
      buyer.locator('[data-testid^="rfq-deadline-"]'),
    ).toContainText(/closes/i);
    // amount renders grouped, e.g. "USD 41,000"
    const quote = buyer
      .locator(tidPrefix('quote-'))
      .filter({ hasText: REVISED_AMOUNT_FMT });
    await expect(quote).toBeVisible();
    // QA-445: the revised offer carries an "Updated" badge — the buyer
    // connects the revised-email to this row.
    await expect(
      quote.locator('[data-testid^="quote-updated-"]'),
    ).toContainText(/updated/i);
    // QA-446: one click on Extend moves the live request's close date to
    // a week from today — the row stays put, its quote still attached.
    const extRow = buyer.locator(tid(`buyer-rfq-${extRfqId}`));
    await expect(extRow).toBeVisible();
    await extRow.getByTestId(`extend-rfq-${extRfqId}`).click();
    const weekOut = new Date(Date.now() + 8 * 86_400_000).toLocaleDateString(
      'en-US',
      { month: 'short', day: 'numeric' },
    );
    await expect(
      extRow.locator(tid(`rfq-deadline-${extRfqId}`)),
    ).toContainText(weekOut, { timeout: 15_000 });
    await expect(
      extRow.locator(tid(`rfq-state-${extRfqId}`)),
    ).not.toContainText(/closed/i);
    // QA-448: each request carries its live offers count, and the
    // "Ending first" chip re-sorts the inbox (single request here —
    // the pin is that the row + token survive the re-fetch).
    await expect(
      extRow.locator(tid(`offer-count-${extRfqId}`)),
    ).toContainText(/1 offer/i);
    await buyer.getByTestId('buyer-sort-ending').click();
    await expect(
      buyer.locator(tid(`buyer-rfq-${extRfqId}`)),
    ).toBeVisible();
    // The extended request still carries its live quote — accept it.
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

      // QA-437: the same trio rides the listing page's operator card — the
      // RFQ decision point gets the trust signals, not just the profile.
      const [lst] = await sql<{ id: string }[]>`
        select id from listings where title = ${LISTING_TITLE}`;
      await buyer.goto(`/listing/${lst!.id}`);
      await expect(
        buyer.getByTestId('operator-deals-count'),
      ).toHaveText('1 deal closed');
      await expect(
        buyer.getByTestId('operator-member-since'),
      ).toContainText('since');
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
    // QA-441: the buyer-facing reply-speed stat reflected back — the op
    // just quoted seconds after the RFQ, so the tile reads ~1h, never 0h.
    await expect(operator.getByTestId('operator-stats')).toContainText(
      'Typical reply',
    );
    await expect(operator.getByTestId('operator-stats')).toContainText('~1h');
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
