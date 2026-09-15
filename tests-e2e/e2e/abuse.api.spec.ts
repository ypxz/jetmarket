// RFQ abuse guards (T15): honeypot fake-accept, captcha verify via the mock
// provider's force-fail token, and the per-IP hourly rate limit.
// The limiter buckets on x-forwarded-for, so a unique test IP isolates the
// bucket from the core-loop spec (which posts on the default "local" key).
import { expect, request, test } from '@playwright/test';

const run = Date.now();
const IP = `198.51.100.${(run % 200) + 1}`;

test('rfq abuse: captcha force-fail → 403, honeypot → fake 201, rate limit → 429', async () => {
  const ctx = await request.newContext({
    extraHTTPHeaders: { 'x-forwarded-for': IP },
  });

  // Captcha failure short-circuits before the repo is touched — a bogus
  // listingId still 403s rather than 404ing.
  const denied = await ctx.post('/api/rfqs', {
    data: {
      listingId: 'no-such-listing',
      buyerEmail: 'bot@x.test',
      fields: {},
      captchaToken: 'force-fail',
    },
  });
  expect(denied.status()).toBe(403);

  // Honeypot: silently fake-accepted (no RFQ persisted).
  const spam = await ctx.post('/api/rfqs', {
    data: {
      listingId: 'no-such-listing',
      buyerEmail: `spam-${run}@x.test`,
      fields: {},
      website: 'filled-by-a-bot',
    },
  });
  expect(spam.status()).toBe(201);

  // Rate limit: RFQ_RATE_LIMIT_PER_HOUR defaults to 5 — the counter fires
  // before body parsing, so even malformed posts consume the bucket.
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await ctx.post('/api/rfqs', { data: {} });
    statuses.push(r.status());
  }
  expect(statuses[statuses.length - 1]).toBe(429);
  await ctx.dispose();
});
