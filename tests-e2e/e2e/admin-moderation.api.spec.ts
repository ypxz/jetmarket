// Admin listing moderation at API level (QA-157/QA-247): archive is
// terminal for the owner (no self-revive, no two-hop), pause stays a
// republishable nudge, and moderation is admin-only.
import { expect, request, test, type APIRequestContext } from '@playwright/test';

const run = Date.now();
const OPERATOR_EMAIL = `e2e-mod-operator-${run}@jetmarket.local`;
const ADMIN_EMAIL = 'admin@jetmarket.local';

async function login(email: string, role: 'buyer' | 'operator' = 'buyer') {
  const ctx = await request.newContext();
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
