// Operator match-mail unsubscribe (QA-541): the link in every RFQ-match
// mail's footer is a signed per-operator token — one GET flips
// notify_rfq_match off without a session, idempotently, then lands on
// /sign-in?notice=match-muted. Tampered and unknown-operator tokens land
// on the generic invalid-token error instead.
import { expect, request, test } from '@playwright/test';
import { createHmac } from 'node:crypto';
import postgres from 'postgres';

// Same scheme as packages/config/src/tokens.ts (the package resolves CJS
// under playwright's loader, so the spec signs inline). The webServer env
// pins SESSION_SECRET=e2e-only-not-a-secret (playwright.config.ts:114).
const signOpUnsub = (operatorId: string) =>
  `${operatorId}.${createHmac('sha256', process.env.SESSION_SECRET ?? 'e2e-only-not-a-secret')
    .update(`opunsub:${operatorId}`)
    .digest('hex')}`;

// Isolated rate-limit bucket for this spec file (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.31.7' } });

const run = Date.now().toString(36);
const OP_EMAIL = `e2e-opunsub-${run}@jetmarket.local`;

const testDb =
  process.env.TEST_DATABASE_URL ??
  'postgres://jetmarket:jetmarket@localhost:5432/jetmarket_test';

async function login(email: string, role?: 'operator') {
  const ctx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.31.7' },
  });
  const res = await ctx.post('/api/auth/magic-link', { data: { email, role } });
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

test('operator match-mail unsubscribe link mutes notify_rfq_match (QA-541)', async () => {
  test.setTimeout(60_000);
  const sql = postgres(testDb);
  try {
    // Operator exists via the same session sign-up the UI uses.
    const op = await login(OP_EMAIL, 'operator');
    const created = await op.post('/api/operators', {
      data: {
        name: `Unsub Ops ${run}`,
        baseAirport: 'ZRH',
        fleetSummary: '2x PC-24',
      },
    });
    expect(created.status()).toBe(201);
    const [row] =
      await sql`select id, notify_rfq_match from operators
                where user_id = (select id from users where email = ${OP_EMAIL})`;
    expect(row?.notify_rfq_match).toBe(true);
    const opId = row!.id as string;

    const anon = await request.newContext({
      extraHTTPHeaders: { 'fly-client-ip': '10.99.31.7' },
      maxRedirects: 0,
    });
    const token = signOpUnsub(opId);
    const url = (t: string) =>
      `/api/operator/notify/unsubscribe?token=${encodeURIComponent(t)}`;

    // The mailed link GETs the pref off without a session.
    const res = await anon.get(url(token));
    expect([301, 302, 303, 307, 308]).toContain(res.status());
    expect(res.headers()['location']).toContain('notice=match-muted');
    const [after] = await sql`select notify_rfq_match from operators where id = ${opId}`;
    expect(after?.notify_rfq_match).toBe(false);

    // Idempotent — mail-client prefetch / List-Unsubscribe-Post replays.
    const again = await anon.get(url(token));
    expect(again.headers()['location']).toContain('notice=match-muted');

    // Tampered MAC and an unknown operator both land on invalid-token.
    for (const bad of [
      `${opId}.${'0'.repeat(64)}`,
      signOpUnsub('00000000-0000-4000-8000-000000000099'),
      'nosuchop.' + '0'.repeat(64),
    ]) {
      const r = await anon.get(url(bad));
      expect(r.headers()['location']).toContain('error=invalid-token');
    }

    // The session toggle re-arms; the same mailed token still wins —
    // unsubscribe links are static per operator by design.
    const rearm = await op.post('/api/operator/notify-prefs', {
      data: { rfqMatch: true },
    });
    expect(rearm.ok()).toBeTruthy();
    const re = await anon.get(url(token));
    expect(re.headers()['location']).toContain('notice=match-muted');
    const [final] = await sql`select notify_rfq_match from operators where id = ${opId}`;
    expect(final?.notify_rfq_match).toBe(false);
  } finally {
    await sql`delete from users where email = ${OP_EMAIL}`;
    await sql.end();
  }
});
