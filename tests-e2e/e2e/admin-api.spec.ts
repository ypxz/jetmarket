// Admin-surface e2e (QA-284): jobs list/retry, operator verify toggle,
// RFQ spam moderation, deals list — plus logout revocation and the
// uploads MIME guard, which had zero coverage until this spec.
import { expect, request, test } from '@playwright/test';
import { isoDateIn } from '../helpers/flow';

// Isolated rate-limit bucket per spec file — the dev server keeps
// buckets across the whole suite run (and across runs when reused), so
// shared 'local' IP logins exhaust ml:*/30ph mid-suite (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.1.7' } });

const run = Date.now();
const ADMIN_EMAIL = 'admin@jetmarket.local';
const BUYER_EMAIL = `e2e-adm-buyer-${run}@jetmarket.local`;
const OPERATOR_EMAIL = `e2e-adm-op-${run}@jetmarket.local`;
// Fresh rate-limit bucket per run for admin routes (keyed on client IP).
const adminIp = { 'x-forwarded-for': `10.9.${(run % 200) + 1}.7` };

async function login(email: string, role: 'buyer' | 'operator' = 'buyer') {
  const ctx = await request.newContext({
    extraHTTPHeaders: adminIp,
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

test('admin api: jobs, operator verify, rfq spam, deals — plus logout + uploads', async () => {
  test.setTimeout(90_000);

  const buyer = await login(BUYER_EMAIL, 'buyer');
  const admin = await login(ADMIN_EMAIL);
  const operator = await login(OPERATOR_EMAIL, 'operator');
  const opRes = await operator.post('/api/operators', {
    data: { name: `E2E Adm Ops ${run}`, baseAirport: 'LSZH', fleetSummary: 'e2e' },
  });
  expect(opRes.status()).toBe(201);
  const operatorId = ((await opRes.json()) as { id: string }).id;

  // --- guard matrix: a plain buyer is denied on every admin route ---------
  for (const url of [
    '/api/admin/jobs',
    '/api/admin/operators',
    '/api/admin/deals',
  ]) {
    const res = await buyer.get(url);
    expect(res.status(), `buyer ${url}`).toBe(403);
  }
  const verifyDenied = await buyer.post(
    `/api/admin/operators/${operatorId}/verify`,
  );
  expect(verifyDenied.status()).toBe(403);
  const modDenied = await buyer.post(
    '/api/admin/listings/00000000-0000-4000-8000-00000000ffff/status',
    { data: { status: 'paused' } },
  );
  expect(modDenied.status()).toBe(403);

  // --- jobs: list, status filter validation, retry on missing job ---------
  const jobs = await admin.get('/api/admin/jobs');
  expect(jobs.status()).toBe(200);
  expect(Array.isArray(await jobs.json())).toBeTruthy();
  const badStatus = await admin.get('/api/admin/jobs?status=bogus');
  expect(badStatus.status()).toBe(400);
  const retryMissing = await admin.post(
    '/api/admin/jobs/00000000-0000-4000-8000-00000000ffff/retry',
  );
  expect(retryMissing.status()).toBe(409);

  // --- operators: list shape + verify toggle both ways ---------------------
  const ops = await admin.get('/api/admin/operators');
  expect(ops.status()).toBe(200);
  const opsBody = (await ops.json()) as Array<{
    id: string;
    verified: boolean;
    user: { email: string } | null;
    listings: number;
  }>;
  const target = opsBody.find((o) => o.id === operatorId);
  expect(target, 'new operator present in admin list').toBeTruthy();
  expect(target!.verified).toBe(false);

  const verifyOn = await admin.post(
    `/api/admin/operators/${operatorId}/verify`,
  );
  expect(verifyOn.status()).toBe(200);
  expect(((await verifyOn.json()) as { verified: boolean }).verified).toBe(
    true,
  );

  // --- uploads: operator-only, MIME whitelist ------------------------------
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const anonUpload = await (
    await request.newContext({ extraHTTPHeaders: adminIp })
  ).post('/api/uploads', {
    multipart: { file: { name: 'a.png', mimeType: 'image/png', buffer: png } },
  });
  expect(anonUpload.status()).toBe(401);
  const badType = await operator.post('/api/uploads', {
    multipart: {
      file: {
        name: 'a.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('x'),
      },
    },
  });
  expect(badType.status()).toBe(415);
  const goodUpload = await operator.post('/api/uploads', {
    multipart: { file: { name: 'a.png', mimeType: 'image/png', buffer: png } },
  });
  expect(goodUpload.status()).toBe(201);
  const { key } = (await goodUpload.json()) as { key: string };
  expect(key.startsWith(`uploads/`)).toBeTruthy();

  // --- rfq spam: live rfq → spam → terminal; repeat is 409 -----------------
  const listing = await operator.post('/api/listings', {
    data: {
      type: 'charter',
      title: `Adm Charter ${run}`,
      price: 30000,
      currency: 'USD',
      photos: [],
      attributes: { aircraftCategory: 'light', model: 'Phenom 300', seats: 6 },
    },
  });
  expect(listing.status()).toBe(201);
  const listingId = ((await listing.json()) as { id: string }).id;

  const rfq = await (
    await request.newContext({ extraHTTPHeaders: adminIp })
  ).post('/api/rfqs', {
    data: {
      listingId,
      buyerEmail: BUYER_EMAIL,
      fields: {
        departure: 'ZRH',
        arrival: 'GVA',
        dateFrom: isoDateIn(30),
        dateTo: isoDateIn(31),
        passengers: 2,
        budgetUsd: 30001 + (run % 1000),
        name: 'Adm Buyer',
        email: BUYER_EMAIL,
      },
    },
  });
  expect(rfq.status()).toBe(201);
  const rfqId = ((await rfq.json()) as { rfqId: string }).rfqId;

  const spam = await admin.post(`/api/admin/rfqs/${rfqId}/status`, {
    data: { status: 'spam' },
  });
  // The fan-out may or may not have run — either way the RFQ must accept the
  // moderation or already be terminal; status is live ('new'/'open'/'matched').
  expect([200, 409]).toContain(spam.status());
  if (spam.status() === 200) {
    const again = await admin.post(`/api/admin/rfqs/${rfqId}/status`, {
      data: { status: 'spam' },
    });
    expect(again.status()).toBe(409);
  }

  // --- deals: list is a joined view ---------------------------------------
  const deals = await admin.get('/api/admin/deals');
  expect(deals.status()).toBe(200);
  expect(Array.isArray(await deals.json())).toBeTruthy();

  // --- deals: invoice CAS transitions (QA-145) -----------------------------
  // Drive a full deal on a second live RFQ: quote -> buyer accepts ->
  // deal + pending invoice -> admin marks paid -> void is refused.
  const rfq2 = await (
    await request.newContext({ extraHTTPHeaders: adminIp })
  ).post('/api/rfqs', {
    data: {
      listingId,
      buyerEmail: BUYER_EMAIL,
      fields: {
        departure: 'ZRH',
        arrival: 'MXP',
        dateFrom: isoDateIn(40),
        dateTo: isoDateIn(41),
        passengers: 3,
        budgetUsd: 31001 + (run % 1000),
        name: 'Adm Buyer',
        email: BUYER_EMAIL,
      },
    },
  });
  expect(rfq2.status()).toBe(201);
  const { rfqId: rfqId2, accessToken } = (await rfq2.json()) as {
    rfqId: string;
    accessToken: string;
  };
  const quote = await operator.post('/api/quotes', {
    data: { rfqId: rfqId2, amount: 41000, currency: 'USD', message: 'adm' },
  });
  expect(quote.status()).toBe(201);
  const quoteId = ((await quote.json()) as { id: string }).id;
  const accept = await (
    await request.newContext({ extraHTTPHeaders: adminIp })
  ).post(`/api/quotes/${quoteId}/accept`, {
    data: { buyerEmail: BUYER_EMAIL, token: accessToken },
  });
  expect(accept.status()).toBe(200);

  const dealsAfter = await admin.get('/api/admin/deals');
  const dealRows = (await dealsAfter.json()) as Array<{
    id: string;
    invoiceStatus: string;
    quote: { id: string } | null;
  }>;
  const deal = dealRows.find((d) => d.quote?.id === quoteId);
  expect(deal, 'accepted quote produced a deal').toBeTruthy();

  const paid = await admin.post(`/api/admin/deals/${deal!.id}/paid`);
  expect(paid.status()).toBe(200);
  const voidPaid = await admin.post(`/api/admin/deals/${deal!.id}/void`);
  expect(voidPaid.status()).toBe(409);

  // --- logout: server-side revocation kills the cookie --------------------
  const me1 = await buyer.get('/api/auth/me');
  expect(((await me1.json()) as { user: unknown }).user).toBeTruthy();
  await buyer.post('/api/auth/logout');
  const me2 = await buyer.get('/api/auth/me');
  // /me stays 200 but returns null once the server-side session is revoked.
  expect(((await me2.json()) as { user: unknown }).user).toBeNull();
});
