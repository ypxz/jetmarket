// Core acceptance loop at API level (spec §Acceptance) — runs today against
// the merged slice's routes. The browser-level twin lives in pending/ until
// the public pages (/search, /listing/[id], /rfq) land.
//
// Magic-link flow per merged contract: POST /api/auth/magic-link returns
// { devLink } in mock mode → GET devLink sets the jm_session cookie inside
// this request context.
import { expect, request, test, type APIRequestContext } from '@playwright/test';

const run = Date.now();
const OPERATOR_EMAIL = `e2e-operator-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-buyer-${run}@jetmarket.local`;
const ADMIN_EMAIL = 'admin@jetmarket.local';
const LISTING_TITLE = `E2E Charter ${run}`;
const QUOTE_AMOUNT = 42000;
// 3% success fee on charters (lib/fees.ts SUCCESS_FEE_PCT)
const EXPECTED_FEE = QUOTE_AMOUNT * 0.03;

async function login(email: string, role: 'buyer' | 'operator' = 'buyer') {
  const ctx = await request.newContext();
  const res = await ctx.post('/api/auth/magic-link', {
    data: { email, role },
  });
  expect(res.ok()).toBeTruthy();
  const { devLink } = (await res.json()) as { devLink: string };
  expect(devLink).toBeTruthy();
  // callback issues jm_session cookie → stored in ctx
  const cb = await ctx.get(new URL(devLink).pathname + new URL(devLink).search);
  expect(cb.status()).toBeLessThan(400);
  return ctx;
}

async function createListing(
  ctx: APIRequestContext,
  input: { type: string; title: string; price: number; attributes?: Record<string, unknown> },
) {
  const res = await ctx.post('/api/listings', {
    data: { currency: 'USD', photos: [], attributes: {}, ...input },
  });
  return res;
}

test('core loop API: signup → listings → RFQ → quote → accept → deal/fee → upgrade', async ({
  baseURL,
}) => {
  test.setTimeout(60_000);

  // --- health -------------------------------------------------------------
  const health = await (await request.newContext()).get('/api/health');
  expect(health.ok()).toBeTruthy();
  expect((await health.json()).ok).toBe(true);

  // --- operator: signup → profile → 2 listings ----------------------------
  const operator = await login(OPERATOR_EMAIL, 'operator');

  const opRes = await operator.post('/api/operators', {
    data: { name: `E2E Ops ${run}`, baseAirport: 'LSZH', fleetSummary: 'E2E fleet' },
  });
  expect(opRes.status()).toBe(201);
  const operatorId = ((await opRes.json()) as { id: string }).id;

  const l1 = await createListing(operator, {
    type: 'charter',
    title: LISTING_TITLE,
    price: 38000,
    attributes: { aircraftCategory: 'light', model: 'Phenom 300', seats: 7 },
  });
  expect(l1.status()).toBe(201);
  const listingId = ((await l1.json()) as { id: string }).id;

  const l2 = await createListing(operator, {
    type: 'empty_leg',
    title: `E2E Empty Leg ${run}`,
    price: 9500,
    attributes: { from: 'ZRH', to: 'NCE', date: '2026-10-01' },
  });
  expect(l2.status()).toBe(201);

  // --- buyer: search with facets → RFQ ------------------------------------
  // Unique source IP per run — the RFQ rate limiter buckets on
  // x-forwarded-for and persists for the life of a reused dev server.
  const publicCtx = await request.newContext({
    baseURL,
    extraHTTPHeaders: { 'x-forwarded-for': `192.0.2.${(run % 200) + 1}` },
  });
  const search = await publicCtx.get(
    `/api/listings?q=${encodeURIComponent(LISTING_TITLE)}&type=charter`,
  );
  expect(search.ok()).toBeTruthy();
  const results = (await search.json()) as { id: string; title: string }[];
  expect(results.map((l) => l.id)).toContain(listingId);

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
        budgetUsd: 45000,
        name: 'Buyer Test',
        email: BUYER_EMAIL,
      },
    },
  });
  expect(rfq.status()).toBe(201);
  const rfqId = ((await rfq.json()) as { rfqId: string }).rfqId;

  // honeypot submissions are silently dropped (still 201)
  const spam = await publicCtx.post('/api/rfqs', {
    data: { listingId, buyerEmail: `spam-${run}@x.test`, fields: {}, website: 'spammy' },
  });
  expect(spam.status()).toBe(201);

  // --- operator: inbox shows the RFQ, sends quote --------------------------
  const inbox = await operator.get('/api/operator/rfqs');
  expect(inbox.ok()).toBeTruthy();
  const rfqs = (await inbox.json()) as { id: string }[];
  expect(rfqs.map((r) => r.id)).toContain(rfqId);

  const quote = await operator.post('/api/quotes', {
    data: { rfqId, amount: QUOTE_AMOUNT, message: `E2E quote ${run}` },
  });
  expect(quote.status()).toBe(201);
  const quoteId = ((await quote.json()) as { id: string }).id;

  // --- buyer: sees quote, accepts → deal + fee ------------------------------
  const buyerQuotes = await publicCtx.get(
    `/api/buyer/quotes?email=${encodeURIComponent(BUYER_EMAIL)}`,
  );
  expect(buyerQuotes.ok()).toBeTruthy();
  const buyerRfqs = (await buyerQuotes.json()) as {
    quotes: { id: string; status: string }[];
  }[];
  expect(buyerRfqs[0]?.quotes.map((q) => q.id)).toContain(quoteId);

  const accept = await publicCtx.post(`/api/quotes/${quoteId}/accept`, {
    data: { buyerEmail: BUYER_EMAIL },
  });
  expect(accept.ok()).toBeTruthy();
  const { deal } = (await accept.json()) as {
    deal: { feeAmount: number; invoiceStatus: string };
  };
  expect(deal.feeAmount).toBe(EXPECTED_FEE);
  expect(deal.invoiceStatus).toBe('invoiced');

  // QA-1: accepting a quote closes the RFQ (dashboard stops counting it open)
  const afterAccept = await publicCtx.get(
    `/api/buyer/quotes?email=${encodeURIComponent(BUYER_EMAIL)}`,
  );
  const rfqsAfter = (await afterAccept.json()) as { id: string; status: string }[];
  expect(rfqsAfter.find((r) => r.id === rfqId)?.status).toBe('closed');

  // --- admin: fee ledger shows deal + invoice ------------------------------
  const admin = await login(ADMIN_EMAIL);
  const deals = await admin.get('/api/admin/deals');
  expect(deals.ok()).toBeTruthy();
  const ledger = (await deals.json()) as {
    id: string;
    amount: number;
    feeAmount: number;
    operator: { id: string } | null;
  }[];
  const row = ledger.find((d) => d.amount === QUOTE_AMOUNT);
  expect(row).toBeTruthy();
  expect(row!.feeAmount).toBe(EXPECTED_FEE);
  expect(row!.operator?.id).toBe(operatorId);

  // --- free plan limit (3) → 402 → mock checkout → lifted -------------------
  const l3 = await createListing(operator, {
    type: 'charter',
    title: `E2E Third ${run}`,
    price: 30000,
  });
  expect(l3.status()).toBe(201);
  const l4 = await createListing(operator, {
    type: 'charter',
    title: `E2E Fourth ${run}`,
    price: 31000,
  });
  expect(l4.status()).toBe(402);

  const checkout = await operator.post('/api/billing/checkout', {
    data: { plan: 'pro' },
  });
  expect(checkout.ok()).toBeTruthy();
  expect((await checkout.json()).plan).toBe('pro');

  const l5 = await createListing(operator, {
    type: 'charter',
    title: `E2E Post-Upgrade ${run}`,
    price: 31000,
  });
  expect(l5.status()).toBe(201);

  // --- auth guards ----------------------------------------------------------
  const anon = await request.newContext();
  expect((await anon.post('/api/listings', { data: {} })).status()).toBe(401);
  expect((await anon.get('/api/admin/deals')).status()).toBe(403);
});

test('smoke: health + home render', async ({ request }) => {
  const health = await request.get('/api/health');
  expect(health.ok()).toBeTruthy();
  const body = await health.json();
  expect(body.ok).toBe(true);
  expect(body.vertical).toBe(process.env.VERTICAL ?? 'jets');

  const home = await request.get('/');
  expect(home.status()).toBeLessThan(400);
  const html = await home.text();
  expect(html).toContain('<html');
  expect(html.toLowerCase()).not.toContain('internal server error');
});
