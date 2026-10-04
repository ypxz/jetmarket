// Buyer concierge ($49 expedite) end-to-end: a live RFQ's bearer-tokened
// POST /api/rfqs/[id]/concierge flips rfqs.concierge (CAS — a replay is a
// no-op, never a second charge) and delivers every still-delayed fan-out
// match instantly (state 'delayed' → 'pending' + notification job) — the
// same effect the free-plan delay window produces a day later, bought now.
// Mock checkout auto-applies (same in-process webhook emulation as
// billing/checkout), so the flag lands synchronously.
//
// Fixture is self-contained: a fresh free-plan operator plus a delayed
// match row written straight into jetmarket_test — the seeded demo RFQ's
// delayed matches belong to the teaser spec (QA-266: shared-fixture writes
// are cross-spec pollution).
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import postgres from 'postgres';

// Isolated rate-limit bucket for this spec file (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.8.8' } });

const run = Date.now().toString(36);
const OP_EMAIL = `e2e-concierge-op-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-concierge-buyer-${run}@jetmarket.local`;
const RFQ_TOKEN = `concierge-token-${run}`;
const LISTING_TITLE = `E2E Concierge Charter ${run}`;

const testDb =
  process.env.TEST_DATABASE_URL ??
  'postgres://jetmarket:jetmarket@localhost:5432/jetmarket_test';

async function login(email: string, role?: 'operator') {
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

async function inboxHasRfq(ctx: APIRequestContext, rfqId: string) {
  const res = await ctx.get('/app/rfqs');
  expect(res.ok()).toBeTruthy();
  return (await res.text()).includes(rfqId);
}

test('concierge: token-gated $49 expedite flips a delayed match instantly', async () => {
  test.setTimeout(90_000);
  const sql = postgres(testDb);

  // --- fixture: free-plan operator + listing + RFQ + delayed match -------
  const op = await login(OP_EMAIL, 'operator');
  const opRes = await op.post('/api/operators', {
    data: { name: `E2E Concierge Ops ${run}`, baseAirport: 'LSZH' },
  });
  expect(opRes.status()).toBe(201);
  const operatorId = ((await opRes.json()) as { id: string }).id;

  // The RFQ rides a SEEDED pro listing (alpine-jet's first charter): an RFQ
  // on the delayed op's own listing is owner-visible regardless of match
  // state, so it can't prove delayed invisibility.
  const listingId = '00000000-0000-4000-8000-000000000200';

  const rfqId = crypto.randomUUID();
  const deliverAt = new Date(Date.now() + 23 * 3_600_000);
  await sql`
    insert into rfqs (id, vertical, listing_id, buyer_email, fields, status, dedupe_key, access_token)
    values (${rfqId}, 'jets', ${listingId}, ${BUYER_EMAIL}, '{"name":"E2E Buyer"}', 'matched',
            ${`concierge-${run}`}, ${RFQ_TOKEN})`;
  await sql`
    insert into rfq_matches (rfq_id, operator_id, listing_id, state, deliver_at)
    values (${rfqId}, ${operatorId}, ${listingId}, 'delayed', ${deliverAt})`;

  try {
    // Precondition: the delayed match is invisible in the op's inbox.
    expect(await inboxHasRfq(op, rfqId)).toBe(false);

    // Auth gate: malformed → 422; missing token, wrong token, foreign
    // email → 404 (QA-474: token is optional so a session buyer can post
    // {buyerEmail} alone — an absent token then fails auth like a wrong
    // one, never falls back to a schema error).
    const anon = await request.newContext({
      extraHTTPHeaders: { 'fly-client-ip': '10.99.8.8' },
    });
    for (const payload of [{ token: 'x' }, { buyerEmail: 'not-an-email' }]) {
      expect(
        (
          await anon.post(`/api/rfqs/${rfqId}/concierge`, { data: payload })
        ).status(),
      ).toBe(422);
    }
    for (const payload of [
      { buyerEmail: BUYER_EMAIL },
      { buyerEmail: BUYER_EMAIL, token: 'wrong' },
      { buyerEmail: 'other@jetmarket.local', token: RFQ_TOKEN },
    ]) {
      expect(
        (
          await anon.post(`/api/rfqs/${rfqId}/concierge`, { data: payload })
        ).status(),
      ).toBe(404);
    }

    // Pay it.
    const pay = await anon.post(`/api/rfqs/${rfqId}/concierge`, {
      data: { buyerEmail: BUYER_EMAIL, token: RFQ_TOKEN },
    });
    expect(pay.status()).toBe(200);
    const paid = (await pay.json()) as {
      concierge: boolean;
      checkoutUrl: string;
    };
    expect(paid.concierge).toBe(true);
    expect(paid.checkoutUrl).toContain('/billing/mock-payment');

    // The buyer's bearer-gated inbox reflects the flag.
    const buyer = await request.newContext({
      extraHTTPHeaders: { 'fly-client-ip': '10.99.8.8' },
    });
    const inbox = await buyer.get(
      `/api/buyer/quotes?email=${encodeURIComponent(BUYER_EMAIL)}`,
      { headers: { 'x-rfq-token': RFQ_TOKEN } },
    );
    expect(inbox.ok()).toBeTruthy();
    const rows = (await inbox.json()) as {
      id: string;
      concierge?: boolean;
      deliveredTo?: number;
    }[];
    const row = rows.find((r) => r.id === rfqId);
    expect(row?.concierge).toBe(true);
    // QA-401: the just-delivered match shows in the buyer's "In N inboxes".
    expect(row?.deliveredTo).toBe(1);

    // Effect: the delayed match flipped to pending — visible + notify job.
    expect(await inboxHasRfq(op, rfqId)).toBe(true);
    const [match] = await sql`
      select state from rfq_matches where rfq_id = ${rfqId} and operator_id = ${operatorId}`;
    expect(match?.state).toBe('pending');
    const [job] = await sql`
      select status from jobs
      where kind = 'email.quote_notification'
        and payload->>'matchId' = (select id::text from rfq_matches
          where rfq_id = ${rfqId} and operator_id = ${operatorId})`;
    expect(job).toBeTruthy();

    // Idempotent replay — flag stays set, no second charge or notification.
    const replay = await anon.post(`/api/rfqs/${rfqId}/concierge`, {
      data: { buyerEmail: BUYER_EMAIL, token: RFQ_TOKEN },
    });
    expect(replay.status()).toBe(200);
    expect((await replay.json()).concierge).toBe(true);
    const [countRow] = await sql`
      select count(*)::int as n from jobs
      where kind = 'email.quote_notification'
        and payload->>'matchId' = (select id::text from rfq_matches
          where rfq_id = ${rfqId} and operator_id = ${operatorId})`;
    expect(countRow?.n).toBe(1);
  } finally {
    // Jobs reference the match by payload, not FK — remove them first.
    await sql`delete from jobs where payload->>'matchId' in
      (select id::text from rfq_matches where rfq_id = ${rfqId})`;
    await sql`delete from rfq_matches where rfq_id = ${rfqId}`;
    await sql`delete from rfqs where id = ${rfqId}`;
    await sql.end();
  }
});
