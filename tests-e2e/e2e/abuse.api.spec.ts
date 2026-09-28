// RFQ abuse guards (T15): honeypot fake-accept, captcha verify via the mock
// provider's force-fail token, and the per-IP hourly rate limit.
// The limiter buckets on x-forwarded-for. TEST-NET-3 is this spec's dedicated
// segment (core-loop uses 192.0.2.x, lifecycle 198.51.100.x): every spec needs
// a disjoint segment because run-derived octets collide when two spec files
// load within the same millisecond (same Date.now() → same bucket → flaky 429).
import { expect, request, test } from '@playwright/test';

const run = Date.now();
const IP = `203.0.113.${(run % 200) + 1}`;

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

test('magic-link prefetch: GET verifies but does not consume the token', async () => {
  const ctx = await request.newContext({
    extraHTTPHeaders: { 'x-forwarded-for': IP },
  });
  const email = `ml-prefetch-${run}@x.test`;
  const res = await ctx.post('/api/auth/magic-link', { data: { email } });
  const { devLink } = (await res.json()) as { devLink: string };
  const cbUrl = new URL(devLink);
  const token = cbUrl.searchParams.get('token')!;

  // Scanner prefetches the link twice — token must stay live.
  for (let i = 0; i < 2; i++) {
    const peek = await ctx.get(cbUrl.pathname + cbUrl.search);
    expect(peek.status()).toBe(200);
    expect(peek.headers()['content-type']).toContain('text/html');
  }
  // The real user then POSTs the confirm form and gets the session.
  const cb = await ctx.post('/api/auth/callback', { form: { token } });
  expect(cb.status()).toBeLessThan(400);
  expect(await ctx.get('/api/auth/me').then((r) => r.ok())).toBeTruthy();
  // Single-use still holds: a second POST redirects to the sign-in error.
  const replay = await ctx.post('/api/auth/callback', { form: { token } });
  expect(replay.url()).toContain('error=invalid-token');
  await ctx.dispose();
});

test('buyer access resend: indistinguishable for unknown inboxes, capped per-inbox', async () => {
  const ctx = await request.newContext({
    extraHTTPHeaders: { 'x-forwarded-for': IP },
  });
  // Unknown inbox → same {sent:true} 200 as a real one — no enumeration.
  const unknown = await ctx.post('/api/buyer/access', {
    data: { email: `ghost-${run}@x.test` },
  });
  expect(unknown.status()).toBe(200);
  expect(((await unknown.json()) as { sent?: boolean }).sent).toBe(true);

  // Per-inbox cap is 3/hour — the IP bucket (20/hour) stays clear.
  const email = `access-flood-${run}@x.test`;
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await ctx.post('/api/buyer/access', { data: { email } });
    statuses.push(r.status());
  }
  expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
  expect(statuses[3]).toBe(429);
  await ctx.dispose();
});

test('magic-link abuse: per-inbox rate limit → 429', async () => {
  const ctx = await request.newContext({
    extraHTTPHeaders: { 'x-forwarded-for': IP },
  });
  const email = `ml-flood-${run}@x.test`;
  // Per-inbox cap is 10/hour — the IP bucket (30/hour) stays well clear.
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) {
    const r = await ctx.post('/api/auth/magic-link', { data: { email } });
    statuses.push(r.status());
  }
  expect(statuses.slice(0, 10)).not.toContain(429);
  expect(statuses[10]).toBe(429);
  await ctx.dispose();
});
