// QA-534: buyer "Decline all" at UI level — with 2+ sent offers the RFQ row
// offers a two-step bulk decline (reason picker, same as the per-quote one);
// every sent quote dies, the request stays open for new offers.
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

// Isolated rate-limit bucket per spec file (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.26.7' } });

const testDb =
  process.env.TEST_DATABASE_URL ??
  'postgres://jetmarket:jetmarket@localhost:5432/jetmarket_test';

const run = Date.now().toString(36);
const OPERATOR_EMAIL = `e2e-ui-declineall-ops-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-ui-declineall-buyer-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E UI DeclineAll Charter ${run}`;

test('buyer declines every offer at once; the request stays open', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const operator = await browser.newPage();
  const buyer = await browser.newPage();

  await step('operator signs up and lists a charter', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E DeclineAll Ops ${run}`,
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

  let rfqId = '';
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
    rfqId = new URL(buyer.url()).searchParams.get('id')!;
    expect(rfqId).toBeTruthy();
  });

  await step('one quote via the UI, a second fixture quote via SQL', async () => {
    await operator.goto('/app/rfqs');
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    await item.locator(tidPrefix('quote-amount-')).fill('11000');
    await item.locator(tidPrefix('quote-send-')).click();
    await expect(item).toContainText(/quote sent|sent/i);

    // The second live offer needs a different operator — the one-quote-per-
    // op-per-rfq invariant makes a same-op double impossible by design. A
    // seeded operator's sent quote inserted directly is fixture data, the
    // same way concierge.ui plants its delayed match.
    const sql = postgres(testDb);
    try {
      const [listing] = await sql`
        select id, operator_id from listings where title = ${LISTING_TITLE}`;
      const [op] = await sql`
        select id from operators where id <> ${listing!.operator_id}
        order by created_at limit 1`;
      await sql`
        insert into quotes (rfq_id, operator_id, amount_minor, currency, message, status)
        values (${rfqId}, ${op!.id}, 1050000, 'USD', 'competing offer', 'sent')`;
    } finally {
      await sql.end();
    }
  });

  await step('buyer bulk-declines both offers with a reason', async () => {
    await buyer.getByTestId('rfq-view-quotes').click();
    const emailInput = buyer.getByTestId('buyer-email');
    if (!(await emailInput.inputValue())) await emailInput.fill(BUYER_EMAIL);
    await buyer.getByTestId('buyer-load').click();

    const rfq = buyer.locator(tidPrefix('buyer-rfq-')).first();
    await expect(rfq).toBeVisible();
    // li scope — quote-new-/quotehistory-/quoterev- children share the
    // `quote-` prefix but aren't list rows.
    await expect(rfq.locator('li[data-testid^="quote-"]')).toHaveCount(2);
    // Two-step: button → reason picker.
    await rfq.locator(tidPrefix('decline-all-')).click();
    const declineResp = buyer.waitForResponse(
      (r) =>
        r.url().includes('/decline-quotes') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await rfq.locator(tidPrefix('decline-all-reason-price-')).click();
    await declineResp;
    await expect(buyer.getByTestId('accept-msg')).toContainText(
      /declined/i,
    );

    // Both quotes dead, no accept/decline buttons left, request still open.
    await expect(
      rfq.locator('li[data-testid^="quote-"]').filter({ hasText: /declined/i }),
    ).toHaveCount(2);
    await expect(rfq.locator(tidPrefix('accept-'))).toHaveCount(0);
    await expect(rfq.locator(tidPrefix('close-rfq-'))).toBeVisible();
    await expect(rfq.locator(tidPrefix('rfq-deadline-'))).toBeVisible();
    // The bulk control retires — nothing left to decline.
    await expect(rfq.locator(tidPrefix('decline-all-'))).toHaveCount(0);
  });
});
