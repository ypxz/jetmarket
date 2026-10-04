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
});
