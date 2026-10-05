// Machinery-scope pins (QA-545/QA-546): the vertical invariants the core-loop
// spec doesn't assert.
//  A. oneOff divergence — a closed deal consumes a for_sale machine (sold) but
//     a for_rent machine stays on the market (capacity inventory, QA-498's
//     mapping under machinery's mixed taxonomy). Fee table proves the EUR
//     split: for_sale 2% vs for_rent 1.5%.
//  B. Shared-DB isolation on the GDPR routes (QA-543/544 under machinery) —
//     two deploys may share one Postgres; a jets-vertical row in the same
//     buyer mailbox must never appear in, nor be touched by, the machinery
//     deploy's export/delete.
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import postgres from 'postgres';

// Own bucket — the machinery suite shares the dev server's rate limiter with
// every jets spec, so this file can't reuse another file's IP.
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.13.9' } });

const run = Date.now();
const testDb =
  process.env.TEST_DATABASE_URL ??
  'postgres://jetmarket:jetmarket@localhost:5432/jetmarket_test';

// Seeded machinery listings (packages/db/src/seed/machinery.ts): 1200 is
// alpine-werkzeug's first for_sale, 1206 nord-foerdertechnik's first for_rent
// — both outside the demo RFQ trail (which hangs off 1208).
const SALE_LISTING = '00000000-0000-4000-8000-000000001200';
const RENT_LISTING = '00000000-0000-4000-8000-000000001206';

async function mkRfq(ctx: APIRequestContext, listingId: string, email: string) {
  const res = await ctx.post('/api/rfqs', {
    data: {
      listingId,
      buyerEmail: email,
      fields: { name: 'E2E Mach Buyer', email },
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { rfqId: string; accessToken: string };
}

test('machinery scope: for_sale sells out on deal close, for_rent stays live', async () => {
  test.skip(process.env.VERTICAL !== 'machinery', 'run with VERTICAL=machinery');
  const publicCtx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.13.9' },
  });
  const sql = postgres(testDb);
  const SALE_BUYER = `e2e-mach-sale-${run}@jetmarket.local`;
  const RENT_BUYER = `e2e-mach-rent-${run}@jetmarket.local`;
  const rfqIds: string[] = [];
  try {
    // Same deal on both listing kinds — quote SQL-inserted 'sent' so the
    // buyer accept is the only mutation under test.
    for (const [listingId, buyer] of [
      [SALE_LISTING, SALE_BUYER],
      [RENT_LISTING, RENT_BUYER],
    ] as const) {
      const { rfqId, accessToken } = await mkRfq(publicCtx, listingId, buyer);
      rfqIds.push(rfqId);
      const [listing] = await sql`
        select operator_id from listings where id = ${listingId}`;
      const [q] = await sql`
        insert into quotes (rfq_id, operator_id, amount_minor, currency, message, status)
        values (${rfqId}, ${listing!.operator_id}, 1000000, 'EUR', 'machinery offer', 'sent')
        returning id`;
      const accept = await publicCtx.post(`/api/quotes/${q!.id}/accept`, {
        data: { buyerEmail: buyer, token: accessToken },
      });
      expect(accept.status()).toBe(200);
    }

    // One-off consumed: for_sale → sold + 2% success fee on EUR.
    const [saleListing] = await sql`
      select status from listings where id = ${SALE_LISTING}`;
    expect(saleListing!.status).toBe('sold');
    const [saleDeal] = await sql`
      select d.fee_pct, d.fee_amount_minor from deals d
      join quotes q on q.id = d.quote_id
      join rfqs r on r.id = q.rfq_id
      where r.buyer_email = ${SALE_BUYER}`;
    expect(Number(saleDeal!.fee_pct)).toBeCloseTo(0.02, 4);
    expect(Number(saleDeal!.fee_amount_minor)).toBe(20000);

    // Capacity survives: for_rent stays active + only 1.5% fee — a rented
    // machine goes back on the market after its deal.
    const [rentListing] = await sql`
      select status from listings where id = ${RENT_LISTING}`;
    expect(rentListing!.status).toBe('active');
    const [rentDeal] = await sql`
      select d.fee_pct, d.fee_amount_minor from deals d
      join quotes q on q.id = d.quote_id
      join rfqs r on r.id = q.rfq_id
      where r.buyer_email = ${RENT_BUYER}`;
    expect(Number(rentDeal!.fee_pct)).toBeCloseTo(0.015, 4);
    expect(Number(rentDeal!.fee_amount_minor)).toBe(15000);
  } finally {
    for (const rid of rfqIds) {
      await sql`delete from rfq_matches where rfq_id = ${rid}`;
      await sql`delete from deals where quote_id in
        (select id from quotes where rfq_id = ${rid})`;
      await sql`delete from quotes where rfq_id = ${rid}`;
      await sql`delete from rfqs where id = ${rid}`;
    }
    // Restore the seeded row — other machinery runs re-seed anyway, but a
    // mid-suite dogfood shouldn't inherit a sold listing.
    await sql`update listings set status = 'active' where id = ${SALE_LISTING}`;
    await sql.end();
  }
});

test('machinery scope: buyer export + delete never touch another vertical (QA-546)', async () => {
  test.skip(process.env.VERTICAL !== 'machinery', 'run with VERTICAL=machinery');
  const publicCtx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.13.9' },
  });
  const sql = postgres(testDb);
  const BUYER = `e2e-mach-gdpr-${run}@jetmarket.local`;
  let machRfqId = '';
  const jetsRfqId = crypto.randomUUID();
  const jetsToken = `jets-tok-${run}`;
  try {
    const r = await mkRfq(publicCtx, RENT_LISTING, BUYER);
    machRfqId = r.rfqId;
    // Same mailbox on the OTHER deploy's vertical — a shared-DB neighbour the
    // machinery routes must not see or touch (QA-293..302 isolation).
    await sql`
      insert into rfqs (id, vertical, listing_id, buyer_email, fields, status, access_token)
      values (${jetsRfqId}, 'jets', null, ${BUYER}, '{"name":"Jets Deploy"}', 'new', ${jetsToken})`;

    // Export: the machinery tree carries the machinery RFQ only.
    const exp = await publicCtx.get(
      `/api/account/export?email=${encodeURIComponent(BUYER)}&t=${r.accessToken}`,
    );
    expect(exp.status()).toBe(200);
    const data = (await exp.json()) as {
      vertical: string;
      rfqs: { rfq: { id: string; buyerEmail: string } }[];
    };
    expect(data.vertical).toBe('machinery');
    expect(data.rfqs.map((x) => x.rfq.id)).toEqual([machRfqId]);
    expect(JSON.stringify(data)).not.toContain(jetsRfqId);
    // And the neighbour's token can't unlock this mailbox here.
    expect(
      (
        await publicCtx.get(
          `/api/account/export?email=${encodeURIComponent(BUYER)}&t=${jetsToken}`,
        )
      ).status(),
    ).toBe(401);

    // Delete: machinery rows tombstone; the jets row survives byte-identical.
    const del = await publicCtx.post(
      `/api/account/delete?email=${encodeURIComponent(BUYER)}&t=${r.accessToken}`,
    );
    expect(del.status()).toBeLessThan(400);
    const [machAfter] = await sql`
      select buyer_email, status from rfqs where id = ${machRfqId}`;
    expect(machAfter!.buyer_email).toMatch(/^del_.*@deleted\.invalid$/);
    expect(machAfter!.status).toBe('closed');
    const [jetsAfter] = await sql`
      select buyer_email, status, access_token from rfqs where id = ${jetsRfqId}`;
    expect(jetsAfter!.buyer_email).toBe(BUYER);
    expect(jetsAfter!.status).toBe('new');
    expect(jetsAfter!.access_token).toBe(jetsToken);
  } finally {
    if (machRfqId) {
      await sql`delete from rfq_matches where rfq_id = ${machRfqId}`;
      await sql`delete from rfqs where id = ${machRfqId}`;
    }
    await sql`delete from rfqs where id = ${jetsRfqId}`;
    await sql.end();
  }
});
