// QA-528: the operator's once-ever rating OF the buyer — rated on the deal
// wall after close — aggregates on the buyer's email and marks their next
// request "Rated buyer x.x★ · N" in every operator inbox.
import { expect, test } from '@playwright/test';
import postgres from 'postgres';
import {
  createListing,
  createOperatorProfile,
  fillRfqForm,
  signUpAndLogin,
  step,
  tidPrefix,
} from '../helpers/flow';

test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.19.4' } });

const run = Date.now();
const OPERATOR_EMAIL = `e2e-bs-op-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-bs-b-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E BS Charter ${run}`;

test('operator rates the buyer; the next RFQ carries the score', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const operator = await browser.newPage();
  const buyer = await browser.newPage();
  const sql = postgres(process.env.TEST_DATABASE_URL!);

  await step('operator profile + listing; buyer RFQ on it', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E BS Ops ${run}`,
      baseAirport: 'LSZH',
    });
    await createListing(operator, {
      type: 'charter',
      title: LISTING_TITLE,
      price: '21000',
      fields: {
        aircraftCategory: 'mid',
        model: 'Lear 45',
        seats: '8',
        year: '2020',
        baseAirport: 'ZRH',
      },
    });
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
  });

  await step('operator quotes; the buyer accepts — deal closes', async () => {
    await operator.goto('/app/rfqs');
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    // Unrated requester — no score chip yet.
    await expect(
      item.locator('[data-testid^="rfq-buyerscore-"]'),
    ).toHaveCount(0);
    await item.locator(tidPrefix('quote-amount-')).fill('20500');
    const send = operator.waitForResponse(
      (r) =>
        r.url().includes('/api/quotes') &&
        r.request().method() === 'POST' &&
        r.status() === 201,
    );
    await item.locator(tidPrefix('quote-send-')).click();
    await send;

    // Buyer accepts via the bearer-tokened API — the UI deal-rate leg is
    // already pinned by core-loop; here the deal just has to exist.
    const [rfq] = await sql<{ id: string; token: string; quoteId: string }[]>`
      select r.id, r.access_token as token, q.id as "quoteId"
      from rfqs r join quotes q on q.rfq_id = r.id
      where r.buyer_email = ${BUYER_EMAIL}
      order by r.created_at desc limit 1`;
    const accept = await buyer.request.post(
      `/api/quotes/${rfq!.quoteId}/accept`,
      { data: { buyerEmail: BUYER_EMAIL, token: rfq!.token } },
    );
    expect(accept.status()).toBe(200);
  });

  await step('operator rates the buyer once — replay is refused', async () => {
    const [deal] = await sql<{ id: string }[]>`
      select d.id from deals d
      join quotes q on q.id = d.quote_id
      join rfqs r on r.id = q.rfq_id
      where r.buyer_email = ${BUYER_EMAIL}
      order by d.closed_at desc limit 1`;
    await operator.goto('/app');
    const row = operator
      .locator('li')
      .filter({
        has: operator.locator(`[data-testid="rate-buyer-${deal!.id}"]`),
      });
    await expect(
      row.locator(`[data-testid="rate-buyer-${deal!.id}"]`),
    ).toBeVisible();
    await row.locator(`[data-testid="rate-buyer-stars-${deal!.id}"]`).selectOption('4');
    const rate = operator.waitForResponse(
      (r) =>
        r.url().includes(`/api/operator/deals/${deal!.id}/rate`) &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await row.locator(`[data-testid="rate-buyer-${deal!.id}"]`).click();
    await rate;
    // Refresh swaps the control for the read-only score; a second write
    // can't happen from the UI — and the API confirms the once-ever CAS.
    await expect(
      operator.locator(`[data-testid="deal-oprating-${deal!.id}"]`),
    ).toContainText('★ 4', { timeout: 15_000 });
    await expect(
      operator.locator(`[data-testid="rate-buyer-${deal!.id}"]`),
    ).toHaveCount(0);
    const replay = await operator.request.post(
      `/api/operator/deals/${deal!.id}/rate`,
      { data: { rating: 5 } },
    );
    expect(replay.status()).toBe(409);
  });

  await step('operator opens the fee invoice page (QA-561)', async () => {
    // The provider's hosted pay URL settles the balance but isn't a
    // durable record — /app/deals/<id>/invoice renders the document from
    // ledger data so it can always be printed/saved.
    const [deal] = await sql<
      { id: string; fee_minor: number; currency: string }[]
    >`
      select d.id, d.currency, d.fee_amount_minor::float as fee_minor
      from deals d
      join quotes q on q.id = d.quote_id
      join rfqs r on r.id = q.rfq_id
      where r.buyer_email = ${BUYER_EMAIL}
      order by d.closed_at desc limit 1`;

    await operator.goto('/app');
    // QA-563: the ledger footer sums this operator's fees — same Intl
    // shape the invoice uses, currency-correct.
    const feeLabel = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: deal!.currency,
      maximumFractionDigits: 0,
    }).format(deal!.fee_minor / 100);
    await expect(operator.getByTestId('deals-fees')).toContainText(feeLabel);
    const link = operator.getByTestId(`deal-invoice-${deal!.id}`);
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
    await operator.waitForURL(new RegExp(`/app/deals/${deal!.id}/invoice`));

    const invoice = operator.getByTestId('invoice');
    await expect(invoice).toBeVisible();
    await expect(
      operator.getByTestId('invoice-no'),
    ).toContainText('Invoice');
    await expect(operator.getByTestId('invoice-billto')).toContainText(
      OPERATOR_EMAIL,
    );
    await expect(operator.getByTestId('invoice-dealref')).toContainText(
      BUYER_EMAIL,
    );
    // Fee math rendered — same Intl shape formatMoney emits ($1,230).
    await expect(operator.getByTestId('invoice-total')).toContainText(
      feeLabel,
    );
    await expect(operator.getByTestId('invoice-print')).toBeVisible();

    // Another operator's session can't read it — 404, no probing.
    const stranger = await browser.newPage();
    await signUpAndLogin(stranger, `e2e-inv-${run}@jetmarket.local`, 'operator');
    const res = await stranger.request.get(
      `/app/deals/${deal!.id}/invoice`,
    );
    expect(res.status()).toBe(404);
    await stranger.close();
  });

  await step('the buyer\'s next RFQ shows "Rated buyer" in the inbox', async () => {
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

    const [rfq2] = await sql<{ id: string }[]>`
      select id from rfqs where buyer_email = ${BUYER_EMAIL}
      order by created_at desc limit 1`;
    await operator.goto('/app/rfqs');
    await expect(
      operator.locator(`[data-testid="rfq-buyerscore-${rfq2!.id}"]`),
    ).toContainText(/4\.0/, { timeout: 15_000 });
  });

  await sql.end();
});
