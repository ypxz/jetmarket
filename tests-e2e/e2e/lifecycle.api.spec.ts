// Quote/deal lifecycle (T27/T28) at API level: decline, withdraw, mark-paid,
// and the auth/idempotency edges (wrong-email 403, wrong-role 401/403,
// double-action 409). RFQ expiry itself is worker-side (expireStaleRfqs CTE)
// and covered by apps/worker unit tests.
import { expect, request, test, type APIRequestContext } from '@playwright/test';

const run = Date.now();
const OPERATOR_EMAIL = `e2e-lc-operator-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-lc-buyer-${run}@jetmarket.local`;
const ADMIN_EMAIL = 'admin@jetmarket.local';

async function login(email: string, role: 'buyer' | 'operator' = 'buyer') {
  const ctx = await request.newContext();
  const res = await ctx.post('/api/auth/magic-link', { data: { email, role } });
  expect(res.ok()).toBeTruthy();
  const { devLink } = (await res.json()) as { devLink: string };
  const cb = await ctx.get(new URL(devLink).pathname + new URL(devLink).search);
  expect(cb.status()).toBeLessThan(400);
  return ctx;
}

async function sendQuote(
  operator: APIRequestContext,
  rfqId: string,
  amount: number,
) {
  const res = await operator.post('/api/quotes', {
    data: { rfqId, amount, message: `lc ${amount}` },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test('lifecycle: decline → withdraw → accept → mark-paid, with 403/409 edges', async ({
  baseURL,
}) => {
  test.setTimeout(60_000);

  // --- setup: operator + listing, buyer RFQ --------------------------------
  const operator = await login(OPERATOR_EMAIL, 'operator');
  const opRes = await operator.post('/api/operators', {
    data: { name: `LC Ops ${run}`, baseAirport: 'LSZH' },
  });
  expect(opRes.status()).toBe(201);

  const lres = await operator.post('/api/listings', {
    data: {
      type: 'charter',
      title: `LC Charter ${run}`,
      price: 20000,
      currency: 'USD',
      photos: [],
      attributes: { aircraftCategory: 'light', model: 'PC-24', seats: 6 },
    },
  });
  expect(lres.status()).toBe(201);
  const listingId = ((await lres.json()) as { id: string }).id;

  const publicCtx = await request.newContext({
    baseURL,
    // fresh bucket per run — RFQ rate limiter keys on x-forwarded-for
    extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${(run % 200) + 1}` },
  });
  const newRfq = async () => {
    const rfq = await publicCtx.post('/api/rfqs', {
      data: {
        listingId,
        buyerEmail: BUYER_EMAIL,
        fields: {
          departure: 'ZRH',
          arrival: 'NCE',
          dateFrom: '2026-10-01',
          dateTo: '2026-10-03',
          passengers: 4,
          budgetUsd: 25000,
          name: 'LC Buyer',
          email: BUYER_EMAIL,
        },
      },
    });
    expect(rfq.status()).toBe(201);
    return ((await rfq.json()) as { rfqId: string }).rfqId;
  };

  const buyer = await login(BUYER_EMAIL, 'buyer');
  const admin = await login(ADMIN_EMAIL);

  // --- decline --------------------------------------------------------------
  // NB: quotes are unique on (rfq_id, operator_id) — an operator gets ONE
  // quote per rfq even after a decline/withdraw (QA-18). One rfq per action.
  const qDeclined = await sendQuote(operator, await newRfq(), 11000);
  const wrongEmail = await publicCtx.post(`/api/quotes/${qDeclined}/decline`, {
    data: { buyerEmail: `not-${BUYER_EMAIL}` },
  });
  expect(wrongEmail.status()).toBe(403);
  const decline = await publicCtx.post(`/api/quotes/${qDeclined}/decline`, {
    data: { buyerEmail: BUYER_EMAIL },
  });
  expect(decline.ok()).toBeTruthy();
  expect((await decline.json()).status).toBe('declined');
  // double-decline and accept-after-decline are both 409
  expect(
    (
      await publicCtx.post(`/api/quotes/${qDeclined}/decline`, {
        data: { buyerEmail: BUYER_EMAIL },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await publicCtx.post(`/api/quotes/${qDeclined}/accept`, {
        data: { buyerEmail: BUYER_EMAIL },
      })
    ).status(),
  ).toBe(409);

  // --- withdraw -------------------------------------------------------------
  const rfq2 = await newRfq();
  const qWithdrawn = await sendQuote(operator, rfq2, 12000);
  // a non-operator session can't withdraw (401); the operator can
  expect((await buyer.post(`/api/quotes/${qWithdrawn}/withdraw`)).status()).toBe(401);
  const withdraw = await operator.post(`/api/quotes/${qWithdrawn}/withdraw`);
  expect(withdraw.ok()).toBeTruthy();
  expect((await withdraw.json()).status).toBe('withdrawn');
  expect((await operator.post(`/api/quotes/${qWithdrawn}/withdraw`)).status()).toBe(409);
  // QA-18: re-quoting the same rfq after withdrawing hits the
  // (rfq_id, operator_id) unique constraint and 500s instead of a clean 4xx.
  // Flip this expectation when the route maps the conflict properly.
  const requote = await operator.post('/api/quotes', {
    data: { rfqId: rfq2, amount: 12500, message: 'second try' },
  });
  expect(requote.status()).toBe(500);

  // --- accept → invoiced → mark-paid ---------------------------------------
  const qAccepted = await sendQuote(operator, await newRfq(), 30000);
  const accept = await publicCtx.post(`/api/quotes/${qAccepted}/accept`, {
    data: { buyerEmail: BUYER_EMAIL },
  });
  expect(accept.ok()).toBeTruthy();
  const { deal } = (await accept.json()) as {
    deal: { id: string; invoiceStatus: string };
  };
  expect(deal.invoiceStatus).toBe('invoiced');

  // mark-paid is admin-only: buyer → 403, admin → paid, second hit → 409
  expect((await buyer.post(`/api/admin/deals/${deal.id}/paid`)).status()).toBe(403);
  const paid = await admin.post(`/api/admin/deals/${deal.id}/paid`);
  expect(paid.ok()).toBeTruthy();
  const paidDeal = (await paid.json()) as {
    invoiceStatus: string;
    invoiceRef: string | null;
  };
  expect(paidDeal.invoiceStatus).toBe('paid');
  expect(paidDeal.invoiceRef).toBeTruthy();
  expect((await admin.post(`/api/admin/deals/${deal.id}/paid`)).status()).toBe(409);

  // --- ledger reflects settlement ------------------------------------------
  const deals = await admin.get('/api/admin/deals');
  expect(deals.ok()).toBeTruthy();
  const ledger = (await deals.json()) as {
    id: string;
    invoiceStatus: string;
    invoiceRef: string | null;
  }[];
  const row = ledger.find((d) => d.id === deal.id);
  expect(row).toBeTruthy();
  expect(row!.invoiceStatus).toBe('paid');
});
