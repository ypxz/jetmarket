// Admin listing moderation at API level (QA-157/QA-247): archive is
// terminal for the owner (no self-revive, no two-hop), pause stays a
// republishable nudge, and moderation is admin-only.
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { isoDateIn } from '../helpers/flow';

// Isolated rate-limit bucket per spec file — the dev server keeps
// buckets across the whole suite run (and across runs when reused), so
// shared 'local' IP logins exhaust ml:*/30ph mid-suite (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.2.7' } });

const run = Date.now();
const OPERATOR_EMAIL = `e2e-mod-operator-${run}@jetmarket.local`;
const ADMIN_EMAIL = 'admin@jetmarket.local';

async function login(email: string, role: 'buyer' | 'operator' = 'buyer') {
  const ctx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.2.7' },
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

async function createListing(ctx: APIRequestContext, title: string) {
  const res = await ctx.post('/api/listings', {
    data: {
      type: 'charter',
      title,
      price: 38000,
      currency: 'USD',
      photos: [],
      attributes: { aircraftCategory: 'light', model: 'Phenom 300', seats: 7 },
    },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test('admin moderation: archive terminal for owner, pause republishable, admin-only', async () => {
  test.setTimeout(60_000);

  const operator = await login(OPERATOR_EMAIL, 'operator');
  const opRes = await operator.post('/api/operators', {
    data: { name: `E2E Mod Ops ${run}`, baseAirport: 'LSZH', fleetSummary: 'e2e' },
  });
  expect(opRes.status()).toBe(201);

  const archivedId = await createListing(operator, `E2E Mod Archived ${run}`);
  const pausedId = await createListing(operator, `E2E Mod Paused ${run}`);

  const admin = await login(ADMIN_EMAIL);

  // --- archive: admin → public 404 → owner cannot revive -------------------
  const archive = await admin.post(`/api/admin/listings/${archivedId}/status`, {
    data: { status: 'archived' },
  });
  expect(archive.status()).toBe(200);
  expect(((await archive.json()) as { status: string }).status).toBe('archived');

  const publicGet = await (await request.newContext()).get(
    `/api/listings/${archivedId}`,
  );
  expect(publicGet.status()).toBe(404);

  // QA-247: every owner transition out of archived is refused — including
  // the paused hop that used to reopen the door to active.
  for (const status of ['active', 'paused', 'draft'] as const) {
    const revive = await operator.patch(`/api/listings/${archivedId}`, {
      data: { status },
    });
    expect(revive.status(), `archived → ${status}`).toBe(403);
  }

  // --- pause: republishable by the owner (design: nudge, plan cap binds) ---
  const pause = await admin.post(`/api/admin/listings/${pausedId}/status`, {
    data: { status: 'paused' },
  });
  expect(pause.status()).toBe(200);
  expect(((await pause.json()) as { status: string }).status).toBe('paused');
  const pausedPublic = await (await request.newContext()).get(
    `/api/listings/${pausedId}`,
  );
  expect(pausedPublic.status()).toBe(404);

  const republish = await operator.patch(`/api/listings/${pausedId}`, {
    data: { status: 'active' },
  });
  expect(republish.status()).toBe(200);
  const revivedPublic = await (await request.newContext()).get(
    `/api/listings/${pausedId}`,
  );
  expect(revivedPublic.ok()).toBeTruthy();

  // --- non-admin callers can't moderate ------------------------------------
  const denied = await operator.post(`/api/admin/listings/${pausedId}/status`, {
    data: { status: 'archived' },
  });
  expect(denied.status()).toBe(403);
});

// Operator suspension (QA-460): an admin flag hides ALL of the operator's
// supply from public browse, stops new RFQs landing on it, and blocks the
// suspended owner's writes — until a reinstate restores the whole set.
test('admin suspension: supply hides, writes 403, reinstate restores (QA-460)', async () => {
  test.setTimeout(60_000);

  const operator = await login(`e2e-sus-operator-${run}@jetmarket.local`, 'operator');
  const opRes = await operator.post('/api/operators', {
    data: { name: `E2E Sus Ops ${run}`, baseAirport: 'LSZH', fleetSummary: 'e2e' },
  });
  expect(opRes.status()).toBe(201);
  const operatorId = ((await opRes.json()) as { id: string }).id;
  const listingId = await createListing(operator, `E2E Sus Charter ${run}`);

  const publicCtx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.2.8' },
  });
  expect((await publicCtx.get(`/api/listings/${listingId}`)).ok()).toBeTruthy();

  // QA-471: a quote minted BEFORE suspension must not mint a deal while
  // the operator is suspended — enforcement gates deal formation, not
  // just the writes QA-460 covered. Mint the pair up front.
  const SUS_BUYER = `e2e-sus-buyer-${run}@jetmarket.local`;
  const liveRfq = await publicCtx.post('/api/rfqs', {
    data: {
      listingId,
      buyerEmail: SUS_BUYER,
      fields: {
        departure: 'ZRH',
        arrival: 'NCE',
        dateFrom: isoDateIn(14),
        dateTo: isoDateIn(16),
        passengers: 4,
        budgetUsd: 45000,
        name: 'Buyer Test',
        email: SUS_BUYER,
      },
    },
  });
  expect(liveRfq.status()).toBe(201);
  const { rfqId: liveRfqId, accessToken: liveToken } =
    (await liveRfq.json()) as { rfqId: string; accessToken: string };
  const liveQuote = await operator.post('/api/quotes', {
    data: { rfqId: liveRfqId, amount: 42000, message: 'pre-suspend offer' },
  });
  expect(liveQuote.status()).toBe(201);
  const liveQuoteId = ((await liveQuote.json()) as { id: string }).id;

  const admin = await login(ADMIN_EMAIL);
  const suspend = await admin.post(`/api/admin/operators/${operatorId}/suspend`);
  expect(suspend.status()).toBe(200);
  expect(((await suspend.json()) as { suspended: boolean }).suspended).toBe(true);

  // Public surfaces: direct API GET 404s and search drops the row.
  expect((await publicCtx.get(`/api/listings/${listingId}`)).status()).toBe(404);
  const search = await publicCtx.get('/api/listings?type=charter&limit=200');
  expect(search.ok()).toBeTruthy();
  expect(
    ((await search.json()) as { id: string }[]).map((l) => l.id),
  ).not.toContain(listingId);

  // New RFQs refuse the suspended listing like a missing one.
  const rfq = await publicCtx.post('/api/rfqs', {
    data: {
      listingId,
      buyerEmail: `e2e-sus-buyer-${run}@jetmarket.local`,
      fields: {
        departure: 'ZRH',
        arrival: 'NCE',
        dateFrom: isoDateIn(14),
        dateTo: isoDateIn(16),
        passengers: 4,
        budgetUsd: 45000,
        name: 'Buyer Test',
        email: `e2e-sus-buyer-${run}@jetmarket.local`,
      },
    },
  });
  expect(rfq.status()).toBe(404);

  // The suspended owner can't create or edit supply — their existing row
  // stays theirs but writes bounce 403 until reinstatement.
  expect(
    (
      await operator.post('/api/listings', {
        data: {
          type: 'charter',
          title: `E2E Sus Blocked ${run}`,
          price: 38000,
          currency: 'USD',
          photos: [],
          attributes: { aircraftCategory: 'light', model: 'Phenom 300', seats: 7 },
        },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await operator.patch(`/api/listings/${listingId}`, {
        data: { price: 36000 },
      })
    ).status(),
  ).toBe(403);

  // QA-471: the pre-suspension quote can't mint a deal while suspended.
  const acceptWhileSuspended = await publicCtx.post(
    `/api/quotes/${liveQuoteId}/accept`,
    { data: { buyerEmail: SUS_BUYER, token: liveToken } },
  );
  expect(acceptWhileSuspended.status()).toBe(409);

  // QA-472: revising is a market-facing write — suspended ops 403 it like
  // quote creation. (Withdraw stays open: retreat is cleanup, not trade.)
  expect(
    (
      await operator.post(`/api/quotes/${liveQuoteId}/revise`, {
        data: { amount: 43000, currency: 'USD' },
      })
    ).status(),
  ).toBe(403);
  // The buyer inbox flags the dead offer instead of a 409-on-click.
  const buyerInbox = await publicCtx.get(
    `/api/buyer/quotes?email=${encodeURIComponent(SUS_BUYER)}`,
    { headers: { 'x-rfq-token': liveToken } },
  );
  expect(buyerInbox.ok()).toBeTruthy();
  const inboxRfqs = (await buyerInbox.json()) as {
    id: string;
    quotes: { id: string; operator?: { unavailable?: boolean } | null }[];
  }[];
  const susRfq = inboxRfqs.find((r) => r.id === liveRfqId);
  expect(
    susRfq?.quotes.find((q) => q.id === liveQuoteId)?.operator?.unavailable,
  ).toBe(true);

  // Reinstate restores everything in one toggle.
  const reinstate = await admin.post(
    `/api/admin/operators/${operatorId}/suspend`,
  );
  expect(reinstate.status()).toBe(200);
  expect(
    ((await reinstate.json()) as { suspended: boolean }).suspended,
  ).toBe(false);
  expect((await publicCtx.get(`/api/listings/${listingId}`)).ok()).toBeTruthy();
  expect(
    (
      await operator.patch(`/api/listings/${listingId}`, {
        data: { price: 36000 },
      })
    ).ok(),
  ).toBeTruthy();

  // QA-467: both toggles landed on the audit feed.
  expect(await (await admin.get('/en/admin')).text()).toContain(
    'mod-event-operator_suspension_toggled',
  );

  // QA-471: post-reinstate the stale quote accepts normally — suspension
  // gates deal formation only while active, it doesn't void the offer.
  const acceptRestored = await publicCtx.post(
    `/api/quotes/${liveQuoteId}/accept`,
    { data: { buyerEmail: SUS_BUYER, token: liveToken } },
  );
  expect(acceptRestored.ok()).toBeTruthy();
});

// Listing reports (QA-461): buyers flag supply into the admin queue —
// dedupe 409s a repeat open flag, the queue shows it, dismiss CAS closes
// it, and a dismissed flag doesn't block a fresh one.
test('listing reports: flag → queue → dismiss → re-flag allowed (QA-461)', async () => {
  test.setTimeout(60_000);

  const operator = await login(`e2e-rep-operator-${run}@jetmarket.local`, 'operator');
  const opRes = await operator.post('/api/operators', {
    data: { name: `E2E Rep Ops ${run}`, baseAirport: 'LSZH', fleetSummary: 'e2e' },
  });
  expect(opRes.status()).toBe(201);
  const listingId = await createListing(operator, `E2E Rep Charter ${run}`);

  const buyer = await login(`e2e-rep-buyer-${run}@jetmarket.local`);
  const report = await buyer.post(`/api/listings/${listingId}/report`, {
    data: { reason: 'scam', note: 'asked for wire transfer' },
  });
  expect(report.status()).toBe(201);
  const reportId = ((await report.json()) as { id: string }).id;

  // Repeat open flag by the same buyer dedupes to a 409, not a queue clone.
  const dup = await buyer.post(`/api/listings/${listingId}/report`, {
    data: { reason: 'other' },
  });
  expect(dup.status()).toBe(409);

  // The admin queue renders it (server-side page carries the row testid).
  const admin = await login(ADMIN_EMAIL);
  const queue = await admin.get('/en/admin');
  expect(queue.ok()).toBeTruthy();
  expect(await queue.text()).toContain(`report-${reportId}`);

  // Dismiss CAS: once 200, repeat 409; the queue drops the row.
  const dismiss = await admin.post(`/api/admin/reports/${reportId}/dismiss`);
  expect(dismiss.status()).toBe(200);
  expect(
    (await admin.post(`/api/admin/reports/${reportId}/dismiss`)).status(),
  ).toBe(409);
  const queueAfter = await admin.get('/en/admin');
  expect(await queueAfter.text()).not.toContain(`report-${reportId}`);

  // A dismissed flag doesn't block a fresh report on the same listing.
  const again = await buyer.post(`/api/listings/${listingId}/report`, {
    data: { reason: 'unavailable' },
  });
  expect(again.status()).toBe(201);
  const againId = ((await again.json()) as { id: string }).id;

  // Anonymous browsers can't file flags — the write sink is authenticated.
  const anon = await (
    await request.newContext()
  ).post(`/api/listings/${listingId}/report`, { data: { reason: 'scam' } });
  expect(anon.status()).toBe(403);

  // QA-462: archiving the reported listing auto-clears its open flags —
  // the queue empties itself when the enforcement lands.
  const archive = await admin.post(`/api/admin/listings/${listingId}/status`, {
    data: { status: 'archived' },
  });
  expect(archive.status()).toBe(200);
  const queueCleared = await admin.get('/en/admin');
  expect(await queueCleared.text()).not.toContain(`report-${againId}`);
});

// Buyer email blocks (QA-463): the account-level kill — a blocked address
// is refused at RFQ-create (403) until the admin unblocks it.
test('buyer block: RFQ-create 403s while blocked, unblock restores (QA-463)', async () => {
  test.setTimeout(60_000);

  const operator = await login(`e2e-blk-operator-${run}@jetmarket.local`, 'operator');
  const opRes = await operator.post('/api/operators', {
    data: { name: `E2E Blk Ops ${run}`, baseAirport: 'LSZH', fleetSummary: 'e2e' },
  });
  expect(opRes.status()).toBe(201);
  const listingId = await createListing(operator, `E2E Blk Charter ${run}`);

  const publicCtx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.2.9' },
  });
  const BUYER = `e2e-blk-buyer-${run}@jetmarket.local`;
  const mkRfq = () =>
    publicCtx.post('/api/rfqs', {
      data: {
        listingId,
        buyerEmail: BUYER,
        fields: {
          departure: 'ZRH',
          arrival: 'NCE',
          dateFrom: isoDateIn(14),
          dateTo: isoDateIn(16),
          passengers: 4,
          budgetUsd: 45000,
          name: 'Buyer Test',
          email: BUYER,
        },
      },
    });
  expect((await mkRfq()).status()).toBe(201);

  // QA-465: the same address as a signed-in buyer files a listing flag —
  // it must leave the queue when the block lands.
  const buyer = await login(BUYER, 'buyer');
  const flag = await buyer.post(`/api/listings/${listingId}/report`, {
    data: { reason: 'other' },
  });
  expect(flag.status()).toBe(201);

  // QA-468: the buyer's session home shows their own request + the flag's
  // live status — the report feedback loop that didn't exist.
  const account = await buyer.get('/en/account');
  const accountHtml = await account.text();
  expect(accountHtml).toContain('account-report-');
  expect(accountHtml).toContain('under review');
  expect(accountHtml).toContain('account-rfq-');

  const admin = await login(ADMIN_EMAIL);
  const block = await admin.post('/api/admin/buyers/block', {
    data: { email: BUYER.toUpperCase() }, // case-fold: caps can't slip past
  });
  expect(block.status()).toBe(200);
  // QA-464+465: the block flips the demand already delivered — the one
  // live RFQ and the one open flag this buyer left come back counted.
  const blocked = (await block.json()) as {
    rfqsSpammed: number;
    reportsCleared: number;
  };
  expect(blocked.rfqsSpammed).toBe(1);
  expect(blocked.reportsCleared).toBe(1);

  // QA-466: the blocked-address registry lists the row (reason from the
  // block body renders; unblock acts in place from the same section).
  const registry = await admin.get('/en/admin');
  expect(await registry.text()).toContain(`blocked-row-${BUYER}`);
  // The buyer's own view flips too — their flag is now 'reviewed', and
  // reads stay open (blocking gates writes, not the session).
  expect(await (await buyer.get('/en/account')).text()).toContain(
    'reviewed',
  );

  // Blocked: new RFQs 403 (not 404 — the listing exists, the buyer is the
  // problem). The per-RFQ spam mark still works on their history.
  const denied = await mkRfq();
  expect(denied.status()).toBe(403);
  expect(((await denied.json()) as { error: string }).error).toContain(
    'blocked',
  );

  const unblock = await admin.post('/api/admin/buyers/block', {
    data: { email: BUYER },
  });
  expect(unblock.status()).toBe(200);
  expect(((await unblock.json()) as { blocked: boolean }).blocked).toBe(false);
  const afterUnblock = await admin.get('/en/admin');
  expect(await afterUnblock.text()).not.toContain(`blocked-row-${BUYER}`);
  // QA-467: block AND unblock both append to the audit feed.
  const feedText = await (await admin.get('/en/admin')).text();
  expect(feedText).toContain('mod-event-buyer_blocked');
  expect(feedText).toContain('mod-event-buyer_unblocked');
  // The first RFQ was spam-flipped by the block, so dedupe (live-only)
  // misses it and this call mints a fresh row — the point is the request
  // clears the block, not which 2xx it gets.
  expect((await mkRfq()).ok()).toBeTruthy();

  // QA-469: the listing's operator flags the fresh RFQ into moderation —
  // the demand-side twin of the buyer listing flag. Visibility = owns the
  // listing or holds a delivered match (same gate as dismiss).
  const freshRfq = await mkRfq();
  const freshId = ((await freshRfq.json()) as { rfqId: string }).rfqId;
  const rfqFlag = await operator.post(`/api/operator/rfqs/${freshId}/report`, {
    data: { reason: 'spam', note: 'mass solicitation' },
  });
  expect(rfqFlag.status()).toBe(201);
  // One flag per (rfq, operator) — a repeat 409s.
  expect(
    (
      await operator.post(`/api/operator/rfqs/${freshId}/report`, {
        data: { reason: 'duplicate' },
      })
    ).status(),
  ).toBe(409);
  // An operator with no visibility on the RFQ 404s — no existence probe.
  const stranger = await login(
    `e2e-rrep-stranger-${run}@jetmarket.local`,
    'operator',
  );
  const strangerOp = await stranger.post('/api/operators', {
    data: { name: `E2E Stranger ${run}`, baseAirport: 'LFMN', fleetSummary: 'x' },
  });
  expect(strangerOp.status()).toBe(201);
  expect(
    (
      await stranger.post(`/api/operator/rfqs/${freshId}/report`, {
        data: { reason: 'spam' },
      })
    ).status(),
  ).toBe(404);
  const flagId = ((await rfqFlag.json()) as { id: string }).id;
  // Admin RFQ rows carry the flag count as a badge, and QA-470's flag
  // detail section shows the WHY (reason badge, reporter, live status).
  const adminHtml = await (await admin.get('/en/admin')).text();
  expect(adminHtml).toContain(`admin-rfq-flagged-${freshId}`);
  expect(adminHtml).toContain(`rfq-report-${flagId}`);
  expect(adminHtml).toContain(`rfq-report-reason-${flagId}`);
  // QA-479: the flag row itself carries the spam action — the fix is
  // inline, not a scroll away on the RFQ table. (Scope the assert to the
  // flag row's <tr> — the same testid legitimately exists above in the
  // RFQ moderation table.)
  const flagRow = adminHtml.match(
    new RegExp(`<tr[^>]*data-testid="rfq-report-${flagId}"[^>]*>[\\s\\S]*?</tr>`),
  )?.[0];
  expect(flagRow).toContain(`mod-rfq-spam-${freshId}`);
  // …and the flag never blocks enforcement — spam-mark still flips it.
  const spammed = await admin.post(`/api/admin/rfqs/${freshId}/status`, {
    data: { status: 'spam' },
  });
  expect(spammed.status()).toBe(200);
  expect(((await spammed.json()) as { status: string }).status).toBe('spam');
});
