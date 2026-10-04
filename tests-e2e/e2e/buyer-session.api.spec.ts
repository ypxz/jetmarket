// Buyer session parity (QA-474): a signed-in buyer's session proves their
// mailbox — the whole buyer surface (inbox read + every action route)
// works without the emailed bearer token. The token path is kept for
// emailed links (and still wins for a foreign mailbox the session doesn't
// own). Stranger sessions 404 like a bad token always did.
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import postgres from 'postgres';
import { isoDateIn, signUpAndLogin } from '../helpers/flow';

test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.6.6' } });

const run = Date.now();
const OP_EMAIL = `e2e-bs-op-${run}@jetmarket.local`;
const BUYER = `e2e-bs-buyer-${run}@jetmarket.local`;
const STRANGER = `e2e-bs-stranger-${run}@jetmarket.local`;

const testDb =
  process.env.TEST_DATABASE_URL ??
  'postgres://jetmarket:jetmarket@localhost:5432/jetmarket_test';

async function login(email: string, role: 'buyer' | 'operator' = 'buyer') {
  const ctx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.6.6' },
  });
  const res = await ctx.post('/api/auth/magic-link', { data: { email, role } });
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

async function mkRfq(publicCtx: APIRequestContext, listingId: string, email: string) {
  const res = await publicCtx.post('/api/rfqs', {
    data: {
      listingId,
      buyerEmail: email,
      fields: {
        departure: 'ZRH',
        arrival: 'NCE',
        dateFrom: isoDateIn(14),
        dateTo: isoDateIn(16),
        passengers: 4,
        name: 'Buyer Session',
        email,
      },
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { rfqId: string; accessToken: string };
}

test('buyer session: inbox + accept/close/rate without the emailed token (QA-474)', async () => {
  test.setTimeout(90_000);
  const sql = postgres(testDb, { max: 1 });
  const publicCtx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.6.6' },
  });
  let listingId = '';
  const rfqIds: string[] = [];
  try {
    // operator + listing
    const operator = await login(OP_EMAIL, 'operator');
    expect(
      (
        await operator.post('/api/operators', {
          data: { name: `E2E BS Ops ${run}`, baseAirport: 'LSZH' },
        })
      ).status(),
    ).toBe(201);
    const lres = await operator.post('/api/listings', {
      data: {
        type: 'charter',
        title: `E2E BS Charter ${run}`,
        price: 38000,
        currency: 'USD',
        photos: [],
        attributes: {},
      },
    });
    expect(lres.status()).toBe(201);
    listingId = ((await lres.json()) as { id: string }).id;

    // RFQ 1 — quote minted for the session-accept leg.
    const r1 = await mkRfq(publicCtx, listingId, BUYER);
    rfqIds.push(r1.rfqId);
    const q1 = await operator.post('/api/quotes', {
      data: { rfqId: r1.rfqId, amount: 41000, message: 'q1' },
    });
    expect(q1.status()).toBe(201);
    const q1Id = ((await q1.json()) as { id: string }).id;

    const buyer = await login(BUYER);

    // 1. Bare session inbox — no ?email, no token. Whole mailbox shows.
    const inbox = await buyer.get('/api/buyer/quotes');
    expect(inbox.ok()).toBeTruthy();
    const rows = (await inbox.json()) as {
      id: string;
      quotes: { id: string; status: string }[];
    }[];
    const row1 = rows.find((r) => r.id === r1.rfqId);
    expect(row1?.quotes.map((q) => q.id)).toContain(q1Id);

    // 2. Session accept — buyerEmail only, no token.
    const accept = await buyer.post(`/api/quotes/${q1Id}/accept`, {
      data: { buyerEmail: BUYER },
    });
    expect(accept.status()).toBe(200);
    expect(((await accept.json()) as { deal?: { id: string } }).deal?.id).toBeTruthy();

    // 3. RFQ 2 — session close without token.
    const r2 = await mkRfq(publicCtx, listingId, BUYER);
    rfqIds.push(r2.rfqId);
    const close = await buyer.post(`/api/rfqs/${r2.rfqId}/close`, {
      data: { buyerEmail: BUYER },
    });
    expect(close.status()).toBe(200);

    // 4. RFQ 3 — a stranger session can't see or act on it.
    const r3 = await mkRfq(publicCtx, listingId, BUYER);
    rfqIds.push(r3.rfqId);
    const q3 = await operator.post('/api/quotes', {
      data: { rfqId: r3.rfqId, amount: 39000, message: 'q3' },
    });
    const q3Id = ((await q3.json()) as { id: string }).id;
    const stranger = await login(STRANGER);
    const strangerInbox = (await stranger.get('/api/buyer/quotes')) ;
    expect(strangerInbox.ok()).toBeTruthy();
    expect(
      ((await strangerInbox.json()) as { id: string }[]).map((r) => r.id),
    ).not.toContain(r3.rfqId);
    // Accept's auth failure is 403 'not your quote' (uniform-denial route
    // semantics differ per route: close/rate 404, accept/decline 403).
    expect(
      (
        await stranger.post(`/api/quotes/${q3Id}/accept`, {
          data: { buyerEmail: BUYER },
        })
      ).status(),
    ).toBe(403);
    // And claiming the stranger's mailbox gets no further: their own
    // session doesn't match BUYER's RFQ, and no token was supplied.
    expect(
      (
        await stranger.post(`/api/rfqs/${r3.rfqId}/close`, {
          data: { buyerEmail: BUYER },
        })
      ).status(),
    ).toBe(404);

    // 5. Token path unchanged — public ctx accepts RFQ 3's quote.
    const tokenAccept = await publicCtx.post(`/api/quotes/${q3Id}/accept`, {
      data: { buyerEmail: BUYER, token: r3.accessToken },
    });
    expect(tokenAccept.status()).toBe(200);

    // 6. Session rate on the sealed deal (QA-451's once-ever CAS intact).
    const [deal] = await sql`
      select d.id from deals d
      join quotes q on q.id = d.quote_id
      where q.id = ${q1Id}`;
    const rate = await buyer.post(`/api/deals/${deal!.id}/rate`, {
      data: { buyerEmail: BUYER, rating: 5 },
    });
    expect(rate.status()).toBe(200);
  } finally {
    for (const rid of rfqIds) {
      await sql`delete from rfq_matches where rfq_id = ${rid}`;
      await sql`delete from deals where quote_id in
        (select id from quotes where rfq_id = ${rid})`;
      await sql`delete from quotes where rfq_id = ${rid}`;
      await sql`delete from rfqs where id = ${rid}`;
    }
    if (listingId) await sql`delete from listings where id = ${listingId}`;
    await sql`delete from operators where user_id in
      (select id from users where email in (${OP_EMAIL}, ${BUYER}, ${STRANGER}))`;
    await sql`delete from users where email in (${OP_EMAIL}, ${BUYER}, ${STRANGER})`;
    await sql.end();
  }
});

test('account page: withdraw a live request via session (QA-475)', async () => {
  const sql = postgres(testDb, { max: 1 });
  const publicCtx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.6.6' },
  });
  let listingId = '';
  let rfqId = '';
  try {
    const operator = await login(OP_EMAIL, 'operator');
    expect(
      (
        await operator.post('/api/operators', {
          data: { name: `E2E BS2 Ops ${run}`, baseAirport: 'LSZH' },
        })
      ).status(),
    ).toBe(201);
    const lres = await operator.post('/api/listings', {
      data: {
        type: 'charter',
        title: `E2E BS2 Charter ${run}`,
        price: 38000,
        currency: 'USD',
        photos: [],
        attributes: {},
      },
    });
    expect(lres.status()).toBe(201);
    listingId = ((await lres.json()) as { id: string }).id;

    rfqId = (await mkRfq(publicCtx, listingId, BUYER)).rfqId;
    const buyer = await login(BUYER);

    // Live row offers the withdraw control…
    const html1 = await (await buyer.get('/en/account')).text();
    expect(html1).toContain(`account-rfq-withdraw-${rfqId}`);
    // …which is the same session-authed close route (QA-474).
    expect(
      (
        await buyer.post(`/api/rfqs/${rfqId}/close`, {
          data: { buyerEmail: BUYER },
        })
      ).status(),
    ).toBe(200);
    // Closed rows lose the button and the closes-on note.
    const html2 = await (await buyer.get('/en/account')).text();
    expect(html2).toContain(`account-rfq-${rfqId}`);
    expect(html2).not.toContain(`account-rfq-withdraw-${rfqId}`);
  } finally {
    if (rfqId) {
      await sql`delete from rfq_matches where rfq_id = ${rfqId}`;
      await sql`delete from rfqs where id = ${rfqId}`;
    }
    if (listingId) await sql`delete from listings where id = ${listingId}`;
    await sql`delete from operators where user_id in
      (select id from users where email = ${OP_EMAIL})`;
    await sql`delete from users where email in (${OP_EMAIL}, ${BUYER})`;
    await sql.end();
  }
});

test('quotes inbox auto-loads for a signed-in buyer, no click needed (QA-480)', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const sql = postgres(testDb, { max: 1 });
  const publicCtx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.6.7' },
  });
  const page = await browser.newPage();
  let listingId = '';
  let rfqId = '';
  try {
    const operator = await login(`e2e-bs-auto-op-${run}@jetmarket.local`, 'operator');
    expect(
      (
        await operator.post('/api/operators', {
          data: { name: `E2E Auto Ops ${run}`, baseAirport: 'LSZH' },
        })
      ).status(),
    ).toBe(201);
    const lres = await operator.post('/api/listings', {
      data: {
        type: 'charter',
        title: `E2E Auto Charter ${run}`,
        price: 38000,
        currency: 'USD',
        photos: [],
        attributes: {},
      },
    });
    expect(lres.status()).toBe(201);
    listingId = ((await lres.json()) as { id: string }).id;

    rfqId = (await mkRfq(publicCtx, listingId, BUYER)).rfqId;

    // Signed-in buyer opens /quotes bare — no ?email, no #t= token. The
    // session resolves their mailbox and the row appears on its own;
    // the email input backfills to who we're acting as.
    await signUpAndLogin(page, BUYER, 'buyer');
    await page.goto('/quotes');
    await expect(page.getByTestId(`buyer-rfq-${rfqId}`)).toBeVisible();
    await expect(page.getByTestId('buyer-email')).toHaveValue(BUYER);
  } finally {
    await page.close();
    if (rfqId) {
      await sql`delete from rfq_matches where rfq_id = ${rfqId}`;
      await sql`delete from rfqs where id = ${rfqId}`;
    }
    if (listingId) await sql`delete from listings where id = ${listingId}`;
    await sql`delete from operators where user_id in
      (select id from users where email = ${`e2e-bs-auto-op-${run}@jetmarket.local`})`;
    await sql`delete from users where email in
      (${`e2e-bs-auto-op-${run}@jetmarket.local`}, ${BUYER})`;
    await sql.end();
  }
});
