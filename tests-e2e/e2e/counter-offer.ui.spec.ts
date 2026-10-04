// QA-511 buyer counter-offer: the buyer names their price on a live
// quote — the operator sees the "Countered" chip + mail and answers by
// revising, which clears the round and lets the buyer accept.
import { expect, test } from '@playwright/test';
import {
  createListing,
  createOperatorProfile,
  fillRfqForm,
  signUpAndLogin,
  step,
  tidPrefix,
} from '../helpers/flow';

// Isolated rate-limit bucket per spec file (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.15.9' } });

const run = Date.now().toString(36);
const OPERATOR_EMAIL = `e2e-ui-counter-ops-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-ui-counter-buyer-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E UI Counter Charter ${run}`;

test('buyer counters a quote; operator revises; buyer accepts', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const operator = await browser.newPage();
  const buyer = await browser.newPage();

  await step('operator signs up and lists a charter', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E Counter Ops ${run}`,
      baseAirport: 'LSZH',
    });
    await createListing(operator, {
      type: 'charter',
      title: LISTING_TITLE,
      price: '12000',
      fields: { aircraftCategory: 'mid', model: 'PC-24', seats: '8', year: '2021', baseAirport: 'ZRH' },
    });
    await expect(operator).toHaveURL(/\/app/);
  });

  await step('buyer sends an RFQ on the listing', async () => {
    await buyer.goto('/search');
    await buyer.getByTestId('facet-q').fill(LISTING_TITLE);
    await buyer.getByTestId('facet-apply').click();
    await buyer
      .getByTestId('search-result')
      .filter({ hasText: LISTING_TITLE })
      .first()
      .click();
    await buyer.getByTestId('listing-rfq-cta').click();
    await buyer.waitForURL(/\/rfq\//, { timeout: 15_000 }).catch(async () => {
      await buyer.getByTestId('listing-rfq-cta').click();
      await buyer.waitForURL(/\/rfq\//, { timeout: 15_000 });
    });
    await fillRfqForm(buyer, BUYER_EMAIL);
    await buyer.getByTestId('rfq-submit').click();
    await buyer.waitForURL(/\/rfq\/thanks/, { timeout: 15_000 });
    await expect(buyer.getByTestId('rfq-confirmation')).toBeVisible({
      timeout: 10_000,
    });
  });

  await step('operator quotes the RFQ', async () => {
    await operator.goto('/app/rfqs');
    const item = operator.locator('li[data-testid^="rfq-"]').filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    await item.locator(tidPrefix('quote-amount-')).fill('11000');
    const sendResp = operator.waitForResponse(
      (r) =>
        r.url().includes('/api/quotes') &&
        r.request().method() === 'POST' &&
        r.status() === 201,
    );
    await item.locator(tidPrefix('quote-send-')).click();
    await sendResp;
    await expect(item).toContainText(/quote sent|sent/i);
  });

  await step('buyer counters under the ask', async () => {
    await buyer.getByTestId('rfq-view-quotes').click();
    const emailInput = buyer.getByTestId('buyer-email');
    if (!(await emailInput.inputValue())) await emailInput.fill(BUYER_EMAIL);
    const loadResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/api/buyer/quotes') &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
    await buyer.getByTestId('buyer-load').click();
    await loadResp;
    const quote = buyer.locator(tidPrefix('quote-')).first();
    await expect(quote).toBeVisible();
    const resp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/counter') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await quote.locator(tidPrefix('counter-')).first().click();
    await buyer.locator(tidPrefix('counter-amount-')).fill('9500');
    await buyer.locator(tidPrefix('counter-send-')).click();
    expect((await resp).status()).toBe(200);
    await expect(buyer.getByTestId('accept-msg')).toContainText(
      /counter/i,
    );
    // After reload the card chips the live counter and the Counter
    // button retires — one counter per offer round.
    await expect(quote.locator(tidPrefix('counter-sent-'))).toBeVisible();
    await expect(quote.locator(tidPrefix('counter-amount-'))).toHaveCount(0);
  });

  await step('operator inbox chips the counter', async () => {
    await operator.goto('/app/rfqs');
    const chip = operator.locator('[data-testid^="quote-counter-"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(/counter/i);
    await expect(chip).toContainText('9,500');
    // The dashboard's open-offers row carries the same signal — the op
    // sees a countered offer wherever they look.
    await operator.goto('/app');
    await expect(
      operator.locator('[data-testid^="offer-counter-"]'),
    ).toBeVisible();
  });

  await step('the Countered inbox filter isolates the hot lead (QA-513)', async () => {
    await operator.goto('/app/rfqs');
    await operator.getByTestId('filter-countered').click();
    await expect(operator).toHaveURL(/f=countered/);
    // The countered RFQ is the whole view — nothing else qualifies.
    const rows = operator.locator('li[data-testid^="rfq-"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(LISTING_TITLE);
    // The plain inbox keeps it too (a counter doesn't move the row).
    await operator.getByTestId('filter-all').click();
    await expect(
      operator.locator('li[data-testid^="rfq-"]').filter({ hasText: LISTING_TITLE }),
    ).toBeVisible();
  });

  await step('operator meets it with a revise — the round clears', async () => {
    await operator.goto('/app/rfqs');
    const item = operator.locator('li[data-testid^="rfq-"]').filter({ hasText: LISTING_TITLE });
    // 'revise-' also prefixes the inner form inputs — pin the button.
    await item.locator(`button${tidPrefix('revise-')}`).first().click();
    await item.locator(tidPrefix('revise-amount-')).fill('10000');
    const resp = operator.waitForResponse(
      (r) =>
        r.url().includes('/revise') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await item.locator(tidPrefix('revise-save-')).click();
    await resp;
    // The counter chip is gone — the revise answered it.
    await expect(
      item.locator('[data-testid^="quote-counter-"]'),
    ).toHaveCount(0);

    // Buyer reloads: counter chip cleared, revised offer still
    // acceptable — the negotiation round trip closes.
    const loadResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/api/buyer/quotes') &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
    await buyer.reload();
    await loadResp;
    const live = buyer.locator(tidPrefix('quote-')).filter({
      has: buyer.locator(tidPrefix('accept-')),
    });
    await expect(live).toHaveCount(1);
    await expect(live.locator(tidPrefix('counter-sent-'))).toHaveCount(0);
    const acceptResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/accept') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await live.locator(tidPrefix('accept-')).click();
    await acceptResp;
    await expect(buyer.getByTestId('accept-msg')).toContainText(/accepted/i);
  });

  // Round 2 (QA-515): a fresh request on the same listing — this time the
  // operator takes the buyer's number outright instead of revising.
  await step('buyer sends a second RFQ', async () => {
    await buyer.goto('/search');
    await buyer.getByTestId('facet-q').fill(LISTING_TITLE);
    await buyer.getByTestId('facet-apply').click();
    await buyer
      .getByTestId('search-result')
      .filter({ hasText: LISTING_TITLE })
      .first()
      .click();
    await buyer.getByTestId('listing-rfq-cta').click();
    await buyer.waitForURL(/\/rfq\//, { timeout: 15_000 }).catch(async () => {
      await buyer.getByTestId('listing-rfq-cta').click();
      await buyer.waitForURL(/\/rfq\//, { timeout: 15_000 });
    });
    await fillRfqForm(buyer, BUYER_EMAIL);
    await buyer.getByTestId('rfq-submit').click();
    await buyer.waitForURL(/\/rfq\/thanks/, { timeout: 15_000 });
    await expect(buyer.getByTestId('rfq-confirmation')).toBeVisible({
      timeout: 10_000,
    });
  });

  await step('operator quotes it; buyer counters, withdraws, re-counters 9,200', async () => {
    await operator.goto('/app/rfqs');
    // The closed round-1 row shares the listing title — the LIVE row is
    // the one still offering a quote form.
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE })
      .filter({ has: operator.locator(tidPrefix('quote-amount-')) });
    await expect(item).toBeVisible();
    await item.locator(tidPrefix('quote-amount-')).fill('11000');
    const sendResp = operator.waitForResponse(
      (r) =>
        r.url().includes('/api/quotes') &&
        r.request().method() === 'POST' &&
        r.status() === 201,
    );
    await item.locator(tidPrefix('quote-send-')).click();
    await sendResp;

    await buyer.getByTestId('rfq-view-quotes').click();
    const emailInput = buyer.getByTestId('buyer-email');
    if (!(await emailInput.inputValue())) await emailInput.fill(BUYER_EMAIL);
    const loadResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/api/buyer/quotes') &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
    await buyer.getByTestId('buyer-load').click();
    await loadResp;
    // The sent card is the only one still offering actions — the
    // round-1 card is accepted/terminal (counter controls render only
    // on 'sent' + live RFQ).
    const sent = buyer.locator(tidPrefix('quote-')).filter({
      has: buyer.locator(tidPrefix('accept-')),
    });
    await expect(sent).toBeVisible();
    const resp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/counter') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await sent.locator(tidPrefix('counter-')).first().click();
    await buyer.locator(tidPrefix('counter-amount-')).fill('9000');
    await buyer.locator(tidPrefix('counter-send-')).click();
    expect((await resp).status()).toBe(200);

    // QA-518: the buyer rethinks — pull the 9,000 counter off the
    // table, then put a fresh number down. Withdrew != spent: a new
    // counter round opens on the same quote.
    const withdrawResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/counter') &&
        r.request().method() === 'DELETE' &&
        r.status() === 200,
    );
    await sent.locator(tidPrefix('counter-withdraw-')).click();
    await withdrawResp;
    await expect(sent.locator(tidPrefix('counter-sent-'))).toHaveCount(0);
    const recounterResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/counter') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await sent.locator(tidPrefix('counter-')).first().click();
    await buyer.locator(tidPrefix('counter-amount-')).fill('9200');
    // QA-521: the counter carries a one-line note — the operator should
    // see "covers repositioning" under the countered badge.
    await buyer
      .locator(tidPrefix('counter-note-'))
      .fill('covers repositioning');
    await buyer.locator(tidPrefix('counter-send-')).click();
    expect((await recounterResp).status()).toBe(200);
    await expect(sent.locator(tidPrefix('counter-sent-'))).toBeVisible();
  });

  // QA-519: the operator's third answer — decline the 9,200 counter
  // outright. The chip clears (the buyer is mailed that the ask stands),
  // and a fresh round opens: the buyer comes back at 9,100.
  await step('operator declines the counter; buyer re-counters 9,100', async () => {
    await operator.goto('/app/rfqs');
    // QA-520: the Countered chip advertises the hot lead — "Countered (1)"
    // — and the countered row leads the list even though it's the oldest.
    await expect(operator.getByTestId('filter-countered')).toContainText(
      '(1)',
    );
    const firstRow = operator
      .locator('li[data-testid^="rfq-"]')
      .first();
    await expect(firstRow).toContainText(LISTING_TITLE);
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE })
      .filter({ has: operator.locator(tidPrefix('decline-counter-')) });
    await expect(item).toBeVisible();
    // QA-521: the buyer's note rides under the countered badge.
    await expect(
      item.locator(tidPrefix('quote-counter-note-')),
    ).toContainText('covers repositioning');
    const declineResp = operator.waitForResponse(
      (r) =>
        r.url().includes('/decline-counter') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await item.locator(tidPrefix('decline-counter-')).click();
    await item.locator(tidPrefix('decline-counter-yes-')).click();
    await declineResp;
    await expect(item.locator(tidPrefix('quote-counter-'))).toHaveCount(0);

    // QA-523: the operator's own card keeps the negotiation trail —
    // the declined 9,200 (with its note) over the withdrawn 9,000.
    // Both rfqs ride the same listing — the 9,200 amount only appears
    // in this rfq's trail, so it disambiguates the two items.
    await operator.goto('/app/rfqs');
    const opItem = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE })
      .filter({ hasText: '9,200' });
    await expect(opItem.locator(tidPrefix('counterrounds-'))).toBeVisible();
    const opRounds = opItem.locator(tidPrefix('counterround-'));
    await expect(opRounds).toHaveCount(2);
    await expect(opRounds.first()).toContainText('declined');
    await expect(opRounds.first()).toContainText('covers repositioning');
    await expect(opRounds.last()).toContainText('withdrawn');

    // The buyer re-loads: their chip cleared too — the counter round
    // is open again, and they put down 9,100.
    const loadResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/api/buyer/quotes') &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
    await buyer.getByTestId('buyer-load').click();
    await loadResp;
    const sent = buyer.locator(tidPrefix('quote-')).filter({
      has: buyer.locator(tidPrefix('accept-')),
    });
    await expect(sent).toBeVisible();
    await expect(sent.locator(tidPrefix('counter-sent-'))).toHaveCount(0);
    // QA-522: the declined 9,200 round — with its note — sits in the
    // negotiation trail on the card (chip cleared, history persists).
    await expect(
      sent.locator(tidPrefix('counterrounds-')),
    ).toContainText('declined');
    // Two resolved rounds by now (9,000 withdrawn + 9,200 declined,
    // newest first) — scope the note assert to the first.
    await expect(
      sent.locator(tidPrefix('counterround-')).first(),
    ).toContainText('covers repositioning');
    const recounterResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/counter') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await sent.locator(tidPrefix('counter-')).first().click();
    await sent.locator(tidPrefix('counter-amount-')).fill('9100');
    await sent.locator(tidPrefix('counter-send-')).click();
    expect((await recounterResp).status()).toBe(200);
    await expect(sent.locator(tidPrefix('counter-sent-'))).toBeVisible();
  });

  // QA-517: while the round-2 counter still waits, the operator goes
  // Pro — the funnel's "Counters waiting" tile should read exactly 1.
  await step('operator upgrades — stat tile counts the waiting counter', async () => {
    await operator.goto('/app/billing');
    await operator.getByTestId('checkout-pro').click();
    await expect(operator.getByTestId('pro-active')).toBeVisible();
    await operator.goto('/app');
    const stats = operator.getByTestId('operator-stats');
    await expect(stats).toBeVisible();
    // The round-2 counter sits unanswered; round-1's was answered by
    // the revise so it no longer counts. Tile text is label + value
    // (a bare '1' would false-match the 100% seen-rate tile).
    await expect(stats).toContainText(/Counters waiting\s*1/);
    // QA-526: three rounds already resolved across both RFQs (answered
    // 9,500 + withdrawn 9,000 + declined 9,200), none accepted yet —
    // the conversion tile reads n/m, honest at small n.
    await expect(stats).toContainText(/Counter win rate\s*0\/3/);
  });

  await step('operator takes the counter — deal closes at 9,100 (QA-515)', async () => {
    await operator.goto('/app/rfqs');
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE })
      .filter({ has: operator.locator(tidPrefix('accept-counter-')) });
    await expect(item).toBeVisible();
    const resp = operator.waitForResponse(
      (r) =>
        r.url().includes('/accept-counter') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await item.locator(tidPrefix('accept-counter-')).click();
    await item.locator(tidPrefix('accept-counter-yes-')).click();
    await resp;
    await expect(item.locator(tidPrefix('accept-counter-error-'))).toHaveCount(0);

    // Deal row on the dashboard carries the countered price — not the ask.
    await operator.goto('/app');
    await expect(operator.locator('main')).toContainText('9,100');
    // QA-517: the accepted counter left the waiting bucket — the tile
    // reads 0 again beside the won deal.
    await expect(operator.getByTestId('operator-stats')).toContainText(
      /Counters waiting\s*0/,
    );
    // QA-526: 1 accepted of 4 resolved rounds — the funnel's counter
    // conversion now reads in the operator's favor.
    await expect(operator.getByTestId('operator-stats')).toContainText(
      /Counter win rate\s*1\/4/,
    );

    // QA-522: the buyer's card closes the trail — the declined 9,200
    // under the accepted 9,100 (newest first), the open round hidden.
    const finalLoad = buyer.waitForResponse(
      (r) =>
        r.url().includes('/api/buyer/quotes') &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
    await buyer.getByTestId('buyer-load').click();
    await finalLoad;
    const history = buyer.locator(tidPrefix('counterrounds-'));
    await expect(history).toBeVisible();
    const rounds = history.locator(tidPrefix('counterround-'));
    await expect(rounds).toHaveCount(3);
    await expect(rounds.first()).toContainText('accepted');
    await expect(rounds.nth(1)).toContainText('declined');
    await expect(rounds.last()).toContainText('withdrawn');

    // QA-523: …and the operator's card closes the same trail — accepted
    // on top, withdrawn at the bottom. 9,100 disambiguates the rfq row.
    await operator.goto('/app/rfqs');
    const opFinal = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE })
      .filter({ hasText: '9,100' })
      .locator(tidPrefix('counterround-'));
    await expect(opFinal).toHaveCount(3);
    await expect(opFinal.first()).toContainText('accepted');
    await expect(opFinal.last()).toContainText('withdrawn');
  });
});
