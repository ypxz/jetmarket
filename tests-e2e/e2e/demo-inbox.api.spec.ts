// Demo-buyer inbox pin (QA-236/QA-279): the seeded RFQ ships with a live
// `sent` quote so the public demo link — /quotes?email=…&t=demo-buyer-token —
// lands on a payable quote, not an empty list. This is the path an evaluator
// clicks first; pin it end to end at the API layer.
//
// Seeded fixture (packages/db/src/seed/jets.ts): rfq uid(300), buyer
// charter@geneva-pe.example, token "demo-buyer-token", one $14,500 quote from
// geneva-executive (delivered/pro). Machinery's seed mirrors it
// (buyer demo@bavaria-werk.example) — covered by the machinery e2e project.
import { expect, test, type APIRequestContext } from '@playwright/test';

const DEMO_BUYER = 'charter@geneva-pe.example';
const DEMO_TOKEN = 'demo-buyer-token';
const DEMO_RFQ_ID = '00000000-0000-4000-8000-000000000300';

function inbox(request: APIRequestContext, email: string, token?: string) {
  const headers: Record<string, string> = {
    // avoid tripping the per-IP limiter when run alongside the other specs
    'fly-client-ip': '10.236.0.1',
  };
  if (token) headers['x-rfq-token'] = token;
  return request.get(
    `/api/buyer/quotes?email=${encodeURIComponent(email)}`,
    { headers },
  );
}

test.describe('demo buyer inbox (seeded)', () => {
  test('the demo link lands on a payable quote', async ({ request }) => {
    const res = await inbox(request, DEMO_BUYER, DEMO_TOKEN);
    expect(res.status()).toBe(200);
    const rfqs = (await res.json()) as Array<{
      id: string;
      status: string;
      accessToken?: string;
      buyerEmail: string;
      listing: { id: string; browseable: boolean; status: string } | null;
      quotes: Array<{
        id: string;
        amount: number; // major units — the Repo layer converts minor → major
        currency: string;
        status: string;
        operator: { name: string; verified: boolean } | null;
      }>;
      requestFields: { label: string; value: string }[];
    }>;

    const rfq = rfqs.find((r) => r.id === DEMO_RFQ_ID);
    expect(rfq, 'demo RFQ must be reachable by its seeded token').toBeTruthy();
    // Bearer token is proof-of-inbox on the way in — never echoed back out.
    expect(rfq!.accessToken).toBeUndefined();
    expect(rfq!.status).toBe('quoted');
    expect(rfq!.buyerEmail).toBe(DEMO_BUYER);

    expect(rfq!.listing?.browseable).toBe(true);
    expect(rfq!.listing?.status).toBe('active');

    // One live payable quote — the demo must not end at an empty inbox.
    const live = rfq!.quotes.filter((q) => q.status === 'sent');
    expect(live).toHaveLength(1);
    expect(live[0]!.amount).toBe(14_500);
    expect(live[0]!.currency).toBe('USD');
    // Quoting operator renders via the public payload — no userId/plan leak.
    expect(live[0]!.operator?.name).toBeTruthy();
    expect(live[0]!.operator).not.toHaveProperty('userId');
    expect(live[0]!.operator).not.toHaveProperty('plan');

    // Buyer sees their own request fields echoed (QA-241), contact keys stripped.
    const keys = rfq!.requestFields.map((f) => f.label);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join(' ')).not.toMatch(/email|phone/i);
  });

  test('wrong token returns an empty inbox — no enumeration', async ({ request }) => {
    const res = await inbox(request, DEMO_BUYER, 'not-the-demo-token');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test('missing token is refused', async ({ request }) => {
    const res = await inbox(request, DEMO_BUYER);
    expect(res.status()).toBe(401);
  });
});
