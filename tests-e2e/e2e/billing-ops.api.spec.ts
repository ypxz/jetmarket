// Billing-ops surface (QA-285): the mock webhook stays sealed without
// MOCK_WEBHOOK_SECRET (QA-40 — a reachable unsigned route would grant
// free Pro to any operatorId), and the portal endpoint enforces its
// operator-with-profile precondition.
import { expect, request, test } from '@playwright/test';

// Isolated rate-limit bucket per spec file — the dev server keeps
// buckets across the whole suite run (and across runs when reused), so
// shared 'local' IP logins exhaust ml:*/30ph mid-suite (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.4.7' } });

const run = Date.now();
const OPERATOR_EMAIL = `e2e-bill-op-${run}@jetmarket.local`;
const BUYER_EMAIL = `e2e-bill-buyer-${run}@jetmarket.local`;

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

test('billing ops: sealed mock webhook, portal preconditions', async () => {
  // Mock mode: no header/wrong secret -> 403, body never parsed.
  const unsigned = await (await request.newContext()).post(
    '/api/billing/webhook',
    {
      data: { kind: 'checkout.completed', operatorId: 'anyone' },
    },
  );
  expect(unsigned.status()).toBe(403);
  const wrongSecret = await (await request.newContext()).post(
    '/api/billing/webhook',
    {
      headers: { 'x-mock-webhook-secret': 'bogus' },
      data: { kind: 'checkout.completed', operatorId: 'anyone' },
    },
  );
  expect(wrongSecret.status()).toBe(403);

  // Portal: anon 401 -> wrong role 401 -> operator sans profile 409 ->
  // operator with profile 200.
  const anon = await request.newContext();
  expect((await anon.post('/api/billing/portal')).status()).toBe(401);

  const buyer = await login(BUYER_EMAIL, 'buyer');
  expect((await buyer.post('/api/billing/portal')).status()).toBe(401);

  const bareOperator = await login(`e2e-bill-bare-${run}@jetmarket.local`, 'operator');
  expect((await bareOperator.post('/api/billing/portal')).status()).toBe(
    409,
  );

  const operator = await login(OPERATOR_EMAIL, 'operator');
  const opRes = await operator.post('/api/operators', {
    data: { name: `E2E Bill Ops ${run}`, baseAirport: 'LSZH', fleetSummary: 'e2e' },
  });
  expect(opRes.status()).toBe(201);
  const portal = await operator.post('/api/billing/portal');
  expect(portal.status()).toBe(200);
  const { url } = (await portal.json()) as { url: string };
  expect(url.length).toBeGreaterThan(0);
});
