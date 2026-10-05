// QA-529: the buyer flags a received quote — the last unreported surface.
// A "call me at +41…" message is THE fee-circumvention vector; the flag
// lands in the admin quote-reports queue, dedupes per reporter, and the
// admin dismiss is a once-only CAS.
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

test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.20.4' } });

const run = Date.now();
const OPERATOR_EMAIL = `e2e-qr-op-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-qr-b-${run}@jetmarket.local`;
const LISTING_TITLE = `E2E QR Charter ${run}`;

test('buyer flags a quote; admin reviews and dismisses it', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const operator = await browser.newPage();
  const buyer = await browser.newPage();
  const admin = await browser.newPage();
  const sql = postgres(process.env.TEST_DATABASE_URL!);

  await step('operator profile + listing; buyer RFQ; operator quotes', async () => {
    await signUpAndLogin(operator, OPERATOR_EMAIL, 'operator');
    await createOperatorProfile(operator, {
      name: `E2E QR Ops ${run}`,
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

    await operator.goto('/app/rfqs');
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    await item.locator(tidPrefix('quote-amount-')).fill('20500');
    const send = operator.waitForResponse(
      (r) =>
        r.url().includes('/api/quotes') &&
        r.request().method() === 'POST' &&
        r.status() === 201,
    );
    await item.locator(tidPrefix('quote-send-')).click();
    await send;
  });

  await step('buyer opens /quotes and flags the offer', async () => {
    // The thanks page's 'view quotes' link carries the per-RFQ bearer
    // token in #t= — same mailbox proof every buyer action uses.
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
    const quote = buyer.locator('li[data-testid^="quote-"]').first();
    await expect(quote).toBeVisible();

    // Two-step: Report reveals reason chips + a note; send files it.
    await quote.locator('[data-testid^="report-"]').click();
    const flag = buyer.waitForResponse(
      (r) =>
        r.url().includes('/report') &&
        r.request().method() === 'POST' &&
        r.status() === 201,
    );
    await quote.locator('[data-testid^="report-reason-off_platform-"]').click();
    await quote.locator('[data-testid^="report-note-"]').fill('phone number in message');
    await quote.locator('[data-testid^="report-send-"]').click();
    await flag;
    await expect(
      quote.locator('[data-testid^="reported-"]'),
    ).toBeVisible();

    // API replay dedupes to 409 — the open flag already exists.
    const [r] = await sql<{ id: string; token: string; quoteId: string }[]>`
      select r.id, r.access_token as token, q.id as "quoteId"
      from rfqs r join quotes q on q.rfq_id = r.id
      where r.buyer_email = ${BUYER_EMAIL}
      order by r.created_at desc limit 1`;
    const replay = await buyer.request.post(
      `/api/quotes/${r!.quoteId}/report`,
      {
        data: { buyerEmail: BUYER_EMAIL, token: r!.token, reason: 'scam' },
      },
    );
    expect(replay.status()).toBe(409);
  });

  await step('operator revises the flagged offer (QA-535 trail)', async () => {
    // The flag filed against the ORIGINAL message — the op then edits it.
    // Moderation must see the flagged text plus the superseded rung.
    await operator.goto('/app/rfqs');
    const item = operator
      .locator('li[data-testid^="rfq-"]')
      .filter({ hasText: LISTING_TITLE });
    await expect(item).toBeVisible();
    await item.locator(`button${tidPrefix('revise-')}`).first().click();
    await item.locator(tidPrefix('revise-amount-')).fill('19800');
    await item.locator(tidPrefix('revise-message-')).fill('revised terms, no phone');
    const rev = operator.waitForResponse(
      (r) =>
        r.url().includes('/revise') &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await item.locator(tidPrefix('revise-save-')).click();
    await rev;
    await expect(item.locator(`button${tidPrefix('revise-')}`)).toBeVisible();
  });

  await step('admin queue shows the flag; dismiss clears it once', async () => {
    const [report] = await sql<{ id: string }[]>`
      select qr.id from quote_reports qr
      join quotes q on q.id = qr.quote_id
      join rfqs r on r.id = q.rfq_id
      where r.buyer_email = ${BUYER_EMAIL} and qr.status = 'open'
      order by qr.created_at desc limit 1`;
    expect(report).toBeTruthy();

    await signUpAndLogin(admin, `e2e-admin-qr${run}@jetmarket.local`);
    await admin.goto('/admin');
    const section = admin.getByTestId('admin-quote-reports');
    await expect(section).toBeVisible({ timeout: 15_000 });
    const row = section.getByTestId(`quote-report-${report!.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('off_platform');
    await expect(row).toContainText(BUYER_EMAIL);
    await expect(row).toContainText('phone number in message');
    // QA-558: the flag row carries the reporter-block kill (parity with
    // the rfq + deal queues) beside suspend + dismiss.
    await expect(row.getByTestId(`block-buyer-${BUYER_EMAIL}`)).toBeVisible();

    // QA-535: the detail row under the flag carries the CURRENT message
    // and the superseded rung (the flagged text) — moderation reads both.
    const detail = section.getByTestId(`quote-report-detail-${report!.id}`);
    await expect(detail).toContainText('revised terms, no phone');
    await expect(
      detail.locator('[data-testid^="quoterev-"]'),
    ).toHaveCount(1);

    const dismiss = admin.waitForResponse(
      (r) =>
        r.url().includes(`/api/admin/quote-reports/${report!.id}/dismiss`) &&
        r.request().method() === 'POST' &&
        r.status() === 200,
    );
    await row.getByTestId(`dismiss-quote-report-${report!.id}`).click();
    await dismiss;
    await expect(row).toHaveCount(0, { timeout: 15_000 });

    // CAS: a second dismiss 409s.
    const replay = await admin.request.post(
      `/api/admin/quote-reports/${report!.id}/dismiss`,
    );
    expect(replay.status()).toBe(409);
  });

  await step('data-rights panel: export link + two-step delete (QA-559)', async () => {
    // The export/delete routes existed but nothing linked to them — the
    // emailed-link buyer's only path was knowing the URL.
    await buyer.reload();
    const panel = buyer.getByTestId('account-data');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    const exportLink = panel.getByTestId('account-export');
    const href = await exportLink.getAttribute('href');
    expect(href).toContain(`email=${encodeURIComponent(BUYER_EMAIL)}`);
    expect(href).toContain('t=');
    const exportRes = await buyer.request.get(href!);
    expect(exportRes.ok()).toBeTruthy();
    const data = (await exportRes.json()) as {
      email: string;
      rfqs: unknown[];
      quoteReports: unknown[];
    };
    expect(data.email).toBe(BUYER_EMAIL);
    expect(data.rfqs.length).toBeGreaterThan(0);
    expect(data.quoteReports.length).toBeGreaterThan(0);

    // Two-step delete, then the mailbox is tombstoned: the same link
    // that just exported now 401s (no live RFQ bearer left to prove it).
    await panel.getByTestId('account-delete').click();
    await panel.getByTestId('account-delete-confirm').click();
    await expect(buyer.getByTestId('account-deleted')).toBeVisible({
      timeout: 15_000,
    });
    const exportAfter = await buyer.request.get(href!);
    expect(exportAfter.status()).toBe(401);
  });

  await sql.end();
});
