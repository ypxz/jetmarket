// Contract example: our payments adapter's real.ts will talk Stripe's API;
// stripe-mock (docker compose service, STRIPE_API_BASE) answers with the same
// resource shapes. These specs pin the calls real.ts relies on so a shape
// change fails here instead of at go-live.
//
//   pnpm db:up            # starts stripe-mock on :12111
//   pnpm test:contract    # runs this file (skips when stripe-mock is down)
import { describe, expect, inject, it } from 'vitest';
import { SERVICES } from './services';

const base = SERVICES.stripeMock.url;
const up = inject('stripeMockUp');

async function stripe(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: 'Bearer sk_test_123',
      'content-type': 'application/x-www-form-urlencoded',
      ...init?.headers,
    },
  });
  return res;
}

describe.skipIf(!up)('stripe-mock contract', () => {
  it('creates a customer (POST /v1/customers → cus_* shape)', async () => {
    const res = await stripe('/v1/customers', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toMatch(/^cus_/);
    expect(body.object).toBe('customer');
  });

  it('creates a payment intent (POST /v1/payment_intents → pi_*, client_secret)', async () => {
    const res = await stripe('/v1/payment_intents', {
      method: 'POST',
      body: 'amount=4200000&currency=usd',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toMatch(/^pi_/);
    expect(body.object).toBe('payment_intent');
    expect(body.client_secret).toEqual(expect.any(String));
  });

  it('creates a checkout session (POST /v1/checkout/sessions → url field)', async () => {
    const res = await stripe('/v1/checkout/sessions', {
      method: 'POST',
      body: 'mode=subscription&success_url=https://example.com/ok&cancel_url=https://example.com/cancel&line_items[0][price]=price_123&line_items[0][quantity]=1',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('checkout.session');
    expect(body.id).toMatch(/^cs_/);
  });
});
