// Admin-surface e2e (QA-284): jobs list/retry, operator verify toggle,
// RFQ spam moderation, deals list — plus logout revocation and the
// uploads MIME guard, which had zero coverage until this spec.
import { expect, request, test } from '@playwright/test';
import postgres from 'postgres';
import { isoDateIn } from '../helpers/flow';

// Isolated rate-limit bucket per spec file — the dev server keeps
// buckets across the whole suite run (and across runs when reused), so
// shared 'local' IP logins exhaust ml:*/30ph mid-suite (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.1.7' } });

const run = Date.now();
const ADMIN_EMAIL = `e2e-admin-x${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-adm-buyer-${run}@jetmarket.local`;
const OPERATOR_EMAIL = `e2e-adm-op-${run}@jetmarket.local`;
// Fresh rate-limit bucket per run for admin routes (keyed on client IP).
const adminIp = { 'x-forwarded-for': `10.9.${(run % 200) + 1}.7` };

const testDb =
  process.env.TEST_DATABASE_URL ??
  'postgres://jetmarket:jetmarket@localhost:5432/jetmarket_test';

test.afterAll(async () => {
  // Specs own their fixtures (QA-289): the QA-458 rate leg leaves a
  // 5.0-rated deal on this spec's operator — /operators then resolves TWO
  // rating badges for later specs and core-loop's unscoped locator dies
  // on strict mode (QA-481). RFQ matches/quotes/deals/reports cascade
  // off the rfqs + listings deletes.
  const sql = postgres(testDb, { max: 1 });
  try {
    await sql`delete from rfqs where buyer_email = ${BUYER_EMAIL}`;
    await sql`delete from listings where operator_id in
      (select o.id from operators o
       join users u on u.id = o.user_id where u.email = ${OPERATOR_EMAIL})`;
    await sql`delete from operators where user_id in
      (select id from users where email = ${OPERATOR_EMAIL})`;
    await sql`delete from users where email in (${BUYER_EMAIL}, ${OPERATOR_EMAIL})`;
  } finally {
    await sql.end();
  }
});

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

  // --- admin clear-rating (QA-458) --------------------------------------
  // Buyer rates once → admin clears → buyer can re-rate through the same
  // CAS; clearing twice is a 409. The rate route wants the buyer trio.
  const rate = await (
    await request.newContext({ extraHTTPHeaders: adminIp })
  ).post(`/api/deals/${deal!.id}/rate`, {
    data: { buyerEmail: BUYER_EMAIL, token: accessToken, rating: 1 },
  });
  expect(rate.status()).toBe(200);
  const clear1 = await admin.post(
    `/api/admin/deals/${deal!.id}/clear-rating`,
  );
  expect(clear1.status()).toBe(200);
  const clear2 = await admin.post(
    `/api/admin/deals/${deal!.id}/clear-rating`,
  );
  expect(clear2.status()).toBe(409);
  // Re-rate works — the once-ever gate re-opened (rating IS NULL again).
  const rerate = await (
    await request.newContext({ extraHTTPHeaders: adminIp })
  ).post(`/api/deals/${deal!.id}/rate`, {
    data: { buyerEmail: BUYER_EMAIL, token: accessToken, rating: 5 },
  });
  expect(rerate.status()).toBe(200);
  // Admin reads the restored rating back on the ledger row.
  const dealsFinal = await admin.get('/api/admin/deals');
  const finalRow = ((await dealsFinal.json()) as Array<{
    id: string;
    buyerRating?: number;
  }>).find((d) => d.id === deal!.id);
  expect(finalRow?.buyerRating).toBe(5);

  // --- QA-552: ?op=<id> detail card — the moderator's drill-down ----------
  // This op now has: 1 listing, 1 paid deal rated ★5 — the card must join
  // all of it (profile + book + ledger + rating + open-flag counts).
  const detail = await admin.get(`/admin?op=${operatorId}`);
  expect(detail.status()).toBe(200);
  const detailHtml = await detail.text();
  expect(detailHtml).toContain('data-testid="op-detail"');
  expect(detailHtml).toContain(`op-deal-${deal!.id}`);
  expect(detailHtml).toContain(`op-view-${operatorId}`);
  expect(detailHtml).toContain(OPERATOR_EMAIL);
  expect(detailHtml).toContain('op-detail-rating');
  expect(detailHtml).toContain('op-detail-flags');
  // A missing id renders the not-found note, not a crash.
  const missing = await admin.get(
    '/admin?op=00000000-0000-4000-8000-00000000ffff',
  );
  expect(missing.status()).toBe(200);
  expect((await missing.text())).toContain('op-not-found');

  // --- QA-555: buyer flags a deal → admin queue → dismiss → re-flag ----
  // The last unreported entity: bearer-token proof, the flag lands in the
  // open queue (HTML shows it), the admin dismiss CAS fires once, and a
  // dismissed flag doesn't hold the dedupe — the buyer can file again.
  const flag = await (
    await request.newContext({ extraHTTPHeaders: adminIp })
  ).post(`/api/deals/${deal!.id}/report`, {
    data: {
      buyerEmail: BUYER_EMAIL,
      token: accessToken,
      reason: 'no_service',
      note: 'the charter never flew',
    },
  });
  expect(flag.status()).toBe(201);
  const flagRow = (await flag.json()) as { id: string; status: string };
  expect(flagRow.status).toBe('open');
  // Dedupe: the same mailbox re-flagging the open deal 409s.
  const dupe = await (
    await request.newContext({ extraHTTPHeaders: adminIp })
  ).post(`/api/deals/${deal!.id}/report`, {
    data: { buyerEmail: BUYER_EMAIL, token: accessToken, reason: 'scam' },
  });
  expect(dupe.status()).toBe(409);
  // A stranger's mailbox can't flag the deal (403, not 404 — no probing).
  const foreign = await (
    await request.newContext({ extraHTTPHeaders: adminIp })
  ).post(`/api/deals/${deal!.id}/report`, {
    data: {
      buyerEmail: `e2e-stranger-${run}@jetmarket.local`,
      token: 'bogus',
      reason: 'scam',
    },
  });
  expect(foreign.status()).toBe(403);

  const queue = await admin.get('/admin');
  expect(queue.status()).toBe(200);
  const queueHtml = await queue.text();
  expect(queueHtml).toContain(`deal-report-${flagRow.id}`);
  expect(queueHtml).toContain(`deal-report-deal-${flagRow.id}`);
  expect(queueHtml).toContain('no_service');

  const dismiss = await admin.post(
    `/api/admin/deal-reports/${flagRow.id}/dismiss`,
  );
  expect(dismiss.status()).toBe(200);
  const dismissAgain = await admin.post(
    `/api/admin/deal-reports/${flagRow.id}/dismiss`,
  );
  expect(dismissAgain.status()).toBe(409);

  // Dismissed re-arms: the buyer files a fresh flag on the same deal.
  const reflag = await (
    await request.newContext({ extraHTTPHeaders: adminIp })
  ).post(`/api/deals/${deal!.id}/report`, {
    data: { buyerEmail: BUYER_EMAIL, token: accessToken, reason: 'other' },
  });
  expect(reflag.status()).toBe(201);
  const queue2 = await admin.get('/admin');
  const queue2Html = await queue2.text();
  const reflagRow = (await reflag.json()) as { id: string };
  expect(queue2Html).toContain(`deal-report-${reflagRow.id}`);

  // --- QA-556: the flag row carries the enforcement trio inline -------
  // A 'no_service' flag is the revert case — the moderator shouldn't
  // hunt the ledger to act. The row's trailing cell holds suspend +
  // block + dismiss (revert is paid-deal-gated: this fixture IS paid, so
  // it correctly stays off).
  const flagRowStart = queue2Html.indexOf(`deal-report-${reflagRow.id}"`);
  const flagCell = queue2Html.slice(
    flagRowStart,
    queue2Html.indexOf('</tr>', flagRowStart),
  );
  expect(flagCell).toContain(`suspend-${operatorId}`);
  expect(flagCell).toContain(`block-buyer-${BUYER_EMAIL}`);
  expect(flagCell).toContain(`dismiss-deal-report-${reflagRow.id}`);
  expect(flagCell).not.toContain(`revert-deal-${deal!.id}`);

  // --- logout: server-side revocation kills the cookie --------------------
  const me1 = await buyer.get('/api/auth/me');
  expect(((await me1.json()) as { user: unknown }).user).toBeTruthy();
  await buyer.post('/api/auth/logout');
  const me2 = await buyer.get('/api/auth/me');
  // /me stays 200 but returns null once the server-side session is revoked.
  expect(((await me2.json()) as { user: unknown }).user).toBeNull();
});

test('admin api: deal revert voids the fee and frees the consumed one-off (QA-550)', async () => {
  const OP2 = `e2e-adm-op2-${run}@jetmarket.local`;
  const BUYER2 = `e2e-adm-b2-${run}@jetmarket.local`;
  const sql = postgres(testDb, { max: 1 });
  const rfqIds: string[] = [];
  try {
    const admin = await login(ADMIN_EMAIL);
    const operator = await login(OP2, 'operator');
    const opRes = await operator.post('/api/operators', {
      data: { name: `Adm Air Revert ${run}`, baseAirport: 'ZRH' },
    });
    expect(opRes.status()).toBe(201);

    // One-off supply (aircraft_sale) — a closed deal consumes it (QA-498).
    const listing = await operator.post('/api/listings', {
      data: {
        type: 'aircraft_sale',
        title: `Adm Sale ${run}`,
        price: 900000,
        currency: 'USD',
        photos: [],
        attributes: {
          aircraftCategory: 'light',
          model: 'Phenom 300E',
          year: 2020,
          seats: 6,
          rangeNm: 2000,
          hoursTotal: 1200,
        },
      },
    });
    expect(listing.status()).toBe(201);
    const listingId = ((await listing.json()) as { id: string }).id;

    // Buyer RFQ → quote → accept → deal + listing 'sold'.
    const rfqRes = await (
      await request.newContext({ extraHTTPHeaders: adminIp })
    ).post('/api/rfqs', {
      data: {
        listingId,
        buyerEmail: BUYER2,
        fields: {
          departure: 'ZRH',
          arrival: 'MXP',
          dateFrom: isoDateIn(40),
          dateTo: isoDateIn(41),
          passengers: 2,
          name: 'Revert Buyer',
          email: BUYER2,
        },
      },
    });
    expect(rfqRes.status()).toBe(201);
    const { rfqId, accessToken } = (await rfqRes.json()) as {
      rfqId: string;
      accessToken: string;
    };
    rfqIds.push(rfqId);
    const quote = await operator.post('/api/quotes', {
      data: { rfqId, amount: 50000, currency: 'USD', message: 'sale' },
    });
    expect(quote.status()).toBe(201);
    const quoteId = ((await quote.json()) as { id: string }).id;
    const accept = await (
      await request.newContext({ extraHTTPHeaders: adminIp })
    ).post(`/api/quotes/${quoteId}/accept`, {
      data: { buyerEmail: BUYER2, token: accessToken },
    });
    expect(accept.status()).toBe(200);
    const [sold] = await sql`
      select status from listings where id = ${listingId}`;
    expect(sold!.status).toBe('sold');
    const [deal] = await sql`
      select d.id, d.invoice_status from deals d
      join quotes q on q.id = d.quote_id where q.id = ${quoteId}`;

    // Sale fell through — admin reverts: fee voided, machine back on sale.
    const revert = await admin.post(`/api/admin/deals/${deal!.id}/revert`);
    expect(revert.status()).toBe(200);
    const body = (await revert.json()) as {
      restoredListingId?: string;
    };
    expect(body.restoredListingId).toBe(listingId);
    const [restored] = await sql`
      select status from listings where id = ${listingId}`;
    expect(restored!.status).toBe('active');
    const [inv] = await sql`
      select invoice_status from deals where id = ${deal!.id}`;
    expect(inv!.invoice_status).toBe('void');

    // QA-551: neither side can score a voided deal — a ★ here would
    // corrupt the operator's public record for a deal that fell through.
    const rateBuyer = await (
      await request.newContext({ extraHTTPHeaders: adminIp })
    ).post(`/api/deals/${deal!.id}/rate`, {
      data: { buyerEmail: BUYER2, token: accessToken, rating: 1 },
    });
    expect(rateBuyer.status()).toBe(409);
    const rateOp = await operator.post(`/api/operator/deals/${deal!.id}/rate`, {
      data: { rating: 1 },
    });
    expect(rateOp.status()).toBe(409);

    // The freed listing really is live again — a second RFQ closes on it,
    // and that PAID deal correctly refuses revert (money moved).
    const rfq2 = await (
      await request.newContext({ extraHTTPHeaders: adminIp })
    ).post('/api/rfqs', {
      data: {
        listingId,
        buyerEmail: BUYER2,
        fields: {
          departure: 'MXP',
          arrival: 'ZRH',
          dateFrom: isoDateIn(50),
          dateTo: isoDateIn(51),
          passengers: 2,
          name: 'Revert Buyer',
          email: BUYER2,
        },
      },
    });
    expect(rfq2.status()).toBe(201);
    const { rfqId: rfqId2, accessToken: token2 } = (await rfq2.json()) as {
      rfqId: string;
      accessToken: string;
    };
    rfqIds.push(rfqId2);
    const quote2 = await operator.post('/api/quotes', {
      data: { rfqId: rfqId2, amount: 52000, currency: 'USD', message: 'resale' },
    });
    expect(quote2.status()).toBe(201);
    const quoteId2 = ((await quote2.json()) as { id: string }).id;
    const accept2 = await (
      await request.newContext({ extraHTTPHeaders: adminIp })
    ).post(`/api/quotes/${quoteId2}/accept`, {
      data: { buyerEmail: BUYER2, token: token2 },
    });
    expect(accept2.status()).toBe(200);
    const [deal2] = await sql`
      select d.id from deals d
      join quotes q on q.id = d.quote_id where q.id = ${quoteId2}`;
    const paid = await admin.post(`/api/admin/deals/${deal2!.id}/paid`);
    expect(paid.status()).toBe(200);
    const revertPaid = await admin.post(
      `/api/admin/deals/${deal2!.id}/revert`,
    );
    expect(revertPaid.status()).toBe(409);
  } finally {
    for (const rid of rfqIds) {
      await sql`delete from rfq_matches where rfq_id = ${rid}`;
      await sql`delete from deals where quote_id in
        (select id from quotes where rfq_id = ${rid})`;
      await sql`delete from quotes where rfq_id = ${rid}`;
      await sql`delete from rfqs where id = ${rid}`;
    }
    await sql`delete from listings where operator_id in
      (select o.id from operators o
       join users u on u.id = o.user_id where u.email = ${OP2})`;
    await sql`delete from operators where user_id in
      (select id from users where email = ${OP2})`;
    await sql`delete from users where email in (${OP2}, ${BUYER2})`;
    await sql.end();
  }
});
