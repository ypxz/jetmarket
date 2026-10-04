// QA-498+499: one-off inventory sells out — a closed deal on an empty_leg or
// aircraft listing flips it 'sold', ends watches, and sweeps the orphaned
// sibling RFQs (their sent quotes decline, no second deal can ever mint).
// for-sale listing flips it to `sold` (terminal like archived but records
// WHY), ends saved watches, frees the free-tier slot, and blocks a second
// deal on the consumed seat. Capacity listings (charter) are unaffected.
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import postgres from 'postgres';
import { isoDateIn } from '../helpers/flow';

// Isolated rate-limit bucket per spec file (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.8.8' } });

const run = Date.now();

async function login(email: string, role: 'buyer' | 'operator' = 'buyer') {
  const ctx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.8.8' },
  });
  const res = await ctx.post('/api/auth/magic-link', {
    data: { email, role },
  });
  expect(res.ok()).toBeTruthy();
  const { devLink } = (await res.json()) as { devLink: string };
  const cbUrl = new URL(devLink);
  const cb = await ctx.post('/api/auth/callback', {
    form: {
      token: cbUrl.searchParams.get('token')!,
      next: cbUrl.searchParams.get('next') ?? '/',
    },
  });
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
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function sqlOne(q: (sql: postgres.Sql) => Promise<postgres.Row[]>) {
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
  try {
    return await q(sql);
  } finally {
    await sql.end();
  }
}

const statusOf = (table: 'listings' | 'quotes' | 'rfqs', id: string) =>
  sqlOne((sql) => sql`select status from ${sql(table)} where id = ${id}`).then(
    (r) => r[0]?.status as string | undefined,
  );

async function fileRfq(
  publicCtx: APIRequestContext,
  listingId: string,
  buyerEmail: string,
) {
  const rfq = await publicCtx.post('/api/rfqs', {
    data: {
      listingId,
      buyerEmail,
      fields: {
        departure: 'ZRH',
        arrival: 'NCE',
        dateFrom: isoDateIn(14),
        dateTo: isoDateIn(16),
        passengers: 2,
        name: 'Buyer',
        email: buyerEmail,
      },
    },
  });
  return rfq;
}

async function quoteOn(
  operator: APIRequestContext,
  rfqId: string,
  amount: number,
) {
  const quote = await operator.post('/api/quotes', {
    data: { rfqId, amount, message: 'quote' },
  });
  expect(quote.status()).toBe(201);
  return ((await quote.json()) as { id: string }).id;
}

const accept = (
  publicCtx: APIRequestContext,
  quoteId: string,
  buyerEmail: string,
  token: string,
) =>
  publicCtx.post(`/api/quotes/${quoteId}/accept`, {
    data: { buyerEmail, token },
  });

test('QA-498: empty_leg accept flips listing to sold and blocks a second deal', async ({
  baseURL,
}) => {
  test.setTimeout(60_000);
  const operator = await login(`sold-op-${run}@jetmarket.local`, 'operator');
  const opRes = await operator.post('/api/operators', {
    data: { name: `Sold Ops ${run}`, baseAirport: 'LSZH', fleetSummary: 'E2E' },
  });
  expect(opRes.status()).toBe(201);

  const legId = await createListing(operator, {
    type: 'empty_leg',
    title: `E2E Sold Leg ${run}`,
    price: 9500,
    attributes: { from: 'ZRH', to: 'NCE', date: isoDateIn(14) },
  });
  const charterId = await createListing(operator, {
    type: 'charter',
    title: `E2E Capacity ${run}`,
    price: 38000,
    attributes: { aircraftCategory: 'light', model: 'Phenom 300', seats: 7 },
  });

  const publicCtx = await request.newContext({
    baseURL,
    extraHTTPHeaders: { 'x-forwarded-for': `192.0.3.${(run % 200) + 1}` },
  });

  // Two buyers file while the leg is live — the race the sold guard exists
  // for: whoever's deal lands first consumes the seat.
  const buyer1 = `sold-b1-${run}@jetmarket.local`;
  const buyer2 = `sold-b2-${run}@jetmarket.local`;
  const rfq1 = await fileRfq(publicCtx, legId, buyer1);
  expect(rfq1.status()).toBe(201);
  const { rfqId: rfq1Id, accessToken: token1 } = (await rfq1.json()) as {
    rfqId: string;
    accessToken: string;
  };
  const rfq2 = await fileRfq(publicCtx, legId, buyer2);
  expect(rfq2.status()).toBe(201);
  const { rfqId: rfq2Id, accessToken: token2 } = (await rfq2.json()) as {
    rfqId: string;
    accessToken: string;
  };
  const quote1Id = await quoteOn(operator, rfq1Id, 9500);
  const quote2Id = await quoteOn(operator, rfq2Id, 8000);

  // --- the sale: deal closes, the leg leaves the market -------------------
  const acc1 = await accept(publicCtx, quote1Id, buyer1, token1);
  expect(acc1.ok()).toBeTruthy();
  expect(await statusOf('listings', legId)).toBe('sold');
  // Sold isn't public — the listing-page API treats it like archived.
  const gone = await publicCtx.get(`/api/listings/${legId}`);
  expect(gone.status()).toBe(404);
  // …and no new RFQs may be filed on the consumed seat.
  const lateRfq = await fileRfq(publicCtx, legId, `sold-late-${run}@x.test`);
  expect(lateRfq.status()).toBe(404);

  // --- no second deal: the sale swept the pre-sale RFQ (QA-499) ----------
  // The orphan close declined buyer2's live quote, so the late accept
  // 409s on the closed RFQ — before the listing guard is even reached.
  const acc2 = await accept(publicCtx, quote2Id, buyer2, token2);
  expect(acc2.status()).toBe(409);
  expect(await statusOf('quotes', quote2Id)).toBe('declined');
  expect(await statusOf('rfqs', rfq2Id)).toBe('closed');
  expect(await statusOf('listings', legId)).toBe('sold');

  // --- capacity listing unaffected by the same flow ------------------------
  const buyer3 = `sold-b3-${run}@jetmarket.local`;
  const rfq3 = await fileRfq(publicCtx, charterId, buyer3);
  expect(rfq3.status()).toBe(201);
  const { rfqId: rfq3Id, accessToken: token3 } = (await rfq3.json()) as {
    rfqId: string;
    accessToken: string;
  };
  const quote3Id = await quoteOn(operator, rfq3Id, 38000);
  const acc3 = await accept(publicCtx, quote3Id, buyer3, token3);
  expect(acc3.ok()).toBeTruthy();
  expect(await statusOf('listings', charterId)).toBe('active');

  // --- manual mark-sold: one-off only, terminal ----------------------------
  const markSold = await operator.patch(`/api/listings/${charterId}`, {
    data: { status: 'sold' },
  });
  expect(markSold.status()).toBe(422); // capacity types never "sell out"
  expect(await statusOf('listings', charterId)).toBe('active');

  const leg2 = await createListing(operator, {
    type: 'empty_leg',
    title: `E2E Manual Sold ${run}`,
    price: 7000,
    attributes: { from: 'GVA', to: 'LHR', date: isoDateIn(20) },
  });
  const sold = await operator.patch(`/api/listings/${leg2}`, {
    data: { status: 'sold' },
  });
  expect(sold.ok()).toBeTruthy();
  expect(await statusOf('listings', leg2)).toBe('sold');
  // Terminal: transitions back out are refused.
  const reactivate = await operator.patch(`/api/listings/${leg2}`, {
    data: { status: 'active' },
  });
  expect(reactivate.status()).toBe(403);
});

test('QA-504: expired leg blocks the owner quote; re-dating relists it', async ({
  baseURL,
}) => {
  test.setTimeout(60_000);
  const operator = await login(`exp-op-${run}@jetmarket.local`, 'operator');
  const opRes = await operator.post('/api/operators', {
    data: { name: `Expiry Ops ${run}`, baseAirport: 'LSZH', fleetSummary: 'E2E' },
  });
  expect(opRes.status()).toBe(201);

  const legId = await createListing(operator, {
    type: 'empty_leg',
    title: `E2E Expiring Leg ${run}`,
    price: 7200,
    attributes: { from: 'ZRH', to: 'NCE', date: isoDateIn(14) },
  });
  const publicCtx = await request.newContext({
    baseURL,
    extraHTTPHeaders: { 'x-forwarded-for': `192.0.4.${(run % 200) + 1}` },
  });
  const rfq = await fileRfq(publicCtx, legId, `exp-b-${run}@jetmarket.local`);
  expect(rfq.status()).toBe(201);
  const { rfqId } = (await rfq.json()) as { rfqId: string };

  // The leg's date slides into the past — read-time expired (QA-220).
  const expire = await operator.patch(`/api/listings/${legId}`, {
    data: { attributes: { date: '2020-01-01' } },
  });
  expect(expire.status()).toBe(200);

  // The owner's quote on the dead leg 409s — it could never mint a deal.
  const dead = await operator.post('/api/quotes', {
    data: { rfqId, amount: 7200, message: 'dead leg' },
  });
  expect(dead.status()).toBe(409);

  // Re-dating into the future relists it; the same quote path lands.
  const relist = await operator.patch(`/api/listings/${legId}`, {
    data: { attributes: { date: isoDateIn(10) } },
  });
  expect(relist.status()).toBe(200);
  const live = await operator.post('/api/quotes', {
    data: { rfqId, amount: 7200, message: 'relisted' },
  });
  expect(live.status()).toBe(201);
});
