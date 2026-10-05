// Saved-search alerts (QA-403) end-to-end: a buyer subscribes their /search
// filter set via POST /api/search-alerts, confirms via the emailed link,
// then a matching listing activation lands a digest in their mailbox.
// Cooldown: a second activation inside the window queues on pending_ids
// instead of re-mailing; unsubscribe kills the flow.
//
// Fixtures ride HTTP only (subscribe/confirm/listing routes) — the alert
// row is what the feature writes; no seeded SQL fixture needed beyond the
// same teardown the other specs use (own rows only).
import { expect, request, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { isoDateIn } from '../helpers/flow';

// Isolated rate-limit bucket for this spec file (QA-289).
test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.9.9' } });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
// Mock email writes under the process cwd — the dev server roots at
// apps/web, but CLI-driven runs can land under the repo root (same dir set
// as helpers/outbox.ts).
const OUTBOX_DIRS = [
  path.join(repoRoot, 'apps', 'web', 'tmp', 'outbox'),
  path.join(repoRoot, 'tmp', 'outbox'),
];

const run = Date.now().toString(36);
const BUYER = `e2e-alert-buyer-${run}@jetmarket.local`;
const OP_EMAIL = `e2e-alert-op-${run}@jetmarket.local`;

const testDb =
  process.env.TEST_DATABASE_URL ??
  'postgres://jetmarket:jetmarket@localhost:5432/jetmarket_test';

/** Latest mock outbox file addressed to `email`, or null. */
function latestMailTo(email: string): string | null {
  for (const dir of OUTBOX_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.eml'))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const file of files) {
      const body = fs.readFileSync(file, 'utf8');
      if (body.toLowerCase().includes(email.toLowerCase())) return body;
    }
  }
  return null;
}

// Every mail to an address, newest first — an address can legitimately get
// several from one action (QA-500's orphan sweep mails the buyer on top of
// the watch-ended mail, so "the latest" is no longer the one being awaited).
function allMailTo(email: string): string[] {
  const out: string[] = [];
  for (const dir of OUTBOX_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.eml'))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const file of files) {
      const body = fs.readFileSync(file, 'utf8');
      if (body.toLowerCase().includes(email.toLowerCase())) out.push(body);
    }
  }
  return out;
}

async function login(email: string, role?: 'operator') {
  const ctx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.9.9' },
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

test('search alerts: subscribe → confirm → activation digest → unsubscribe (QA-403)', async () => {
  test.setTimeout(90_000);
  const sql = postgres(testDb);
  const tag = `e2e-alert-${run}`;
  const listingId = crypto.randomUUID();
  const listingId2 = crypto.randomUUID();

  try {
    const anon = await request.newContext({
      extraHTTPHeaders: { 'fly-client-ip': '10.99.9.9' },
    });

    // 1. Subscribe — pending row + confirm mail (dev echo carries the link).
    const sub = await anon.post('/api/search-alerts', {
      data: { email: BUYER, params: { type: 'charter' } },
    });
    expect(sub.status()).toBe(200);
    const { created, devConfirmUrl } = (await sub.json()) as {
      created: boolean;
      devConfirmUrl?: string;
    };
    expect(created).toBe(true);
    expect(devConfirmUrl).toContain('/api/search-alerts/confirm?token=');
    const confirmPath = new URL(devConfirmUrl!).pathname +
      new URL(devConfirmUrl!).search;
    const token = new URL(devConfirmUrl!).searchParams.get('token')!;

    const [row] = await sql`
      select status from search_alerts where dedupe_key <> '' and email = ${BUYER}`;
    expect(row?.status).toBe('pending');

    // 2. Confirm — redirect lands on the saved search itself.
    const conf = await anon.get(confirmPath, { maxRedirects: 0 });
    expect([301, 302, 303, 307, 308]).toContain(conf.status());
    const loc = conf.headers()['location']!;
    expect(loc).toContain('/search');
    expect(loc).toContain('type=charter');
    expect(loc).toContain('alert=confirmed');
    const [row2] = await sql`
      select status from search_alerts where email = ${BUYER}`;
    expect(row2?.status).toBe('active');

    // 3. Matching activation → digest mail to the buyer.
    const op = await login(OP_EMAIL, 'operator');
    const opRes = await op.post('/api/operators', {
      data: { name: `E2E Alert Ops ${run}`, baseAirport: 'LSZH' },
    });
    expect(opRes.status()).toBe(201);
    await sql`
      insert into listings (id, operator_id, vertical, type, title, price_minor, currency, status, attributes, photos)
      select ${listingId}, id, 'jets', 'charter', ${`E2E Alert Charter ${run}`},
             1200000, 'USD', 'active', '{}', '[]'
      from operators where user_id = (select id from users where email = ${OP_EMAIL})`;
    // Activation hook only fires through the route — flip via draft→active.
    await sql`update listings set status = 'draft' where id = ${listingId}`;
    const act = await op.patch(`/api/listings/${listingId}`, {
      data: { status: 'active' },
    });
    expect(act.status()).toBe(200);

    // Digest mail lands in the mock outbox.
    let mail: string | null = null;
    for (let i = 0; i < 20 && !mail; i++) {
      mail = latestMailTo(BUYER);
      if (!mail || !mail.includes('saved search')) mail = null;
      if (!mail) await new Promise((r) => setTimeout(r, 500));
    }
    expect(mail, 'expected a saved-search digest mail').toBeTruthy();
    expect(mail!).toContain(`E2E Alert Charter ${run}`);

    // 4. Cooldown: a second activation queues instead of re-mailing.
    const [stamped] = await sql`
      select last_alerted_at from search_alerts where email = ${BUYER}`;
    expect(stamped?.last_alerted_at).not.toBeNull();
    await sql`
      insert into listings (id, operator_id, vertical, type, title, price_minor, currency, status, attributes, photos)
      select ${listingId2}, id, 'jets', 'charter', ${`E2E Alert Charter Two ${run}`},
             900000, 'USD', 'draft', '{}', '[]'
      from operators where user_id = (select id from users where email = ${OP_EMAIL})`;
    const act2 = await op.patch(`/api/listings/${listingId2}`, {
      data: { status: 'active' },
    });
    expect(act2.status()).toBe(200);
    const [queued] = await sql`
      select pending_ids from search_alerts where email = ${BUYER}`;
    expect(queued?.pending_ids).toContain(listingId2);

    // 5. Unsubscribe — link works, status flips, redirect flags the banner.
    const unsub = await anon.get(
      `/api/search-alerts/unsubscribe?token=${encodeURIComponent(token)}`,
      { maxRedirects: 0 },
    );
    expect(unsub.headers()['location']).toContain('alert=unsubscribed');
    const [row3] = await sql`
      select status from search_alerts where email = ${BUYER}`;
    expect(row3?.status).toBe('off');
  } finally {
    await sql`delete from search_alerts where email = ${BUYER}`;
    await sql`delete from listings where id in (${listingId}, ${listingId2})`;
    await sql`delete from operators where user_id in (select id from users where email = ${OP_EMAIL})`;
    await sql`delete from users where email in (${BUYER}, ${OP_EMAIL})`;
    await sql.end();
  }
});

test('listing watch: a live price cut mails "Price dropped" with old → new (QA-459)', async () => {
  test.setTimeout(90_000);
  const sql = postgres(testDb);
  const WATCHER = `e2e-watch-${run}@jetmarket.local`;
  const listingId = crypto.randomUUID();

  try {
    const op = await login(OP_EMAIL, 'operator');
    const opRes = await op.post('/api/operators', {
      data: { name: `E2E Watch Ops ${run}`, baseAirport: 'LSZH' },
    });
    expect(opRes.status()).toBe(201);
    // $12,000 active charter straight in the DB.
    await sql`
      insert into listings (id, operator_id, vertical, type, title, price_minor, currency, status, attributes, photos)
      select ${listingId}, id, 'jets', 'charter', ${`E2E Drop Charter ${run}`},
             1200000, 'USD', 'active', '{}', '[]'
      from operators where user_id = (select id from users where email = ${OP_EMAIL})`;

    // Watch the listing → confirm.
    const anon = await request.newContext({
      extraHTTPHeaders: { 'fly-client-ip': '10.99.9.9' },
    });
    const sub = await anon.post('/api/search-alerts', {
      data: { email: WATCHER, params: { watch: listingId } },
    });
    expect(sub.status()).toBe(200);
    const { devConfirmUrl } = (await sub.json()) as { devConfirmUrl?: string };
    const confPath =
      new URL(devConfirmUrl!).pathname + new URL(devConfirmUrl!).search;
    const conf = await anon.get(confPath, { maxRedirects: 0 });
    expect([301, 302, 303, 307, 308]).toContain(conf.status());

    // Operator cuts the price → watcher gets the framed drop mail.
    const cut = await op.patch(`/api/listings/${listingId}`, {
      data: { price: 8000 },
    });
    expect(cut.status()).toBe(200);
    let mail: string | null = null;
    for (let i = 0; i < 20; i++) {
      mail = latestMailTo(WATCHER);
      if (mail && mail.includes('Price dropped')) break;
      mail = null;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(mail, 'expected a Price dropped mail to the watcher').toBeTruthy();
    expect(mail!).toContain(`E2E Drop Charter ${run}`);
    expect(mail!).toContain('was $12,000');
    expect(mail!).toContain('now $8,000');
    expect(mail!).toContain(`/listing/${listingId}`);
  } finally {
    await sql`delete from search_alerts where email = ${WATCHER}`;
    await sql`delete from listings where id = ${listingId}`;
    await sql`delete from operators where user_id in (select id from users where email = ${OP_EMAIL})`;
    await sql`delete from users where email in (${WATCHER}, ${OP_EMAIL})`;
    await sql.end();
  }
});

test('saved search: subscribe reports the live-match count + the UI shows it (QA-415)', async ({ page }) => {
  test.setTimeout(60_000);
  const sql = postgres(testDb);
  const MATCHER = `e2e-match-${run}@jetmarket.local`;
  const [idA, idB, idC] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const ids = [idA, idB, idC];

  try {
    // Two live listings on a unique facet value, one off-value control.
    const op = await login(OP_EMAIL, 'operator');
    const opRes = await op.post('/api/operators', {
      data: { name: `E2E Match Ops ${run}`, baseAirport: 'LSZH' },
    });
    expect(opRes.status()).toBe(201);
    // The `from` facet is a text facet — a bogus code stays unique next to
    // the seeded airport codes, so the count is exactly our two rows.
    // sql.json() binds a real jsonb object — a `${string}::jsonb` param is
    // JSON-serialized by postgres.js and lands as a quoted string instead.
    const origins = ['XJM99', 'XJM99', 'XJM98'];
    for (const [i, id] of ids.entries()) {
      await sql`
        insert into listings (id, operator_id, vertical, type, title, price_minor, currency, status, attributes, photos)
        select ${id}, id, 'jets', 'charter', ${`E2E Match ${run} ${i}`},
               1200000, 'USD', 'active', ${sql.json({ from: origins[i] })}, '[]'
        from operators where user_id = (select id from users where email = ${OP_EMAIL})`;
    }
    const [seeded] = await sql`
      select count(*)::int as n from listings where id = any(${ids}::uuid[])`;
    expect(seeded?.n, 'fixture listings must exist before the count leg').toBe(3);

    // API leg: the subscribe response carries the current live-match count.
    const anon = await request.newContext({
      extraHTTPHeaders: { 'fly-client-ip': '10.99.9.9' },
    });
    const sub = await anon.post('/api/search-alerts', {
      data: { email: MATCHER, params: { type: 'charter', from: 'xjm99' } },
    });
    expect(sub.status()).toBe(200);
    const body = (await sub.json()) as { matchedNow?: number };
    const [dbCount] = await sql`
      select count(*)::int as n from listings
      where vertical = 'jets' and status = 'active' and type = 'charter'
        and attributes ->> 'from' = 'XJM99'`;
    expect({ matchedNow: body.matchedNow, dbRows: dbCount?.n }).toEqual({
      matchedNow: 2,
      dbRows: 2,
    });

    // UI leg: submitting the /search alert form renders the count line.
    await page.goto('/en/search?type=charter&from=xjm99');
    await page.getByTestId('search-alert-email').fill(MATCHER);
    await page.getByTestId('search-alert-submit').click();
    await expect(page.getByTestId('search-alert-matched')).toContainText('2');
  } finally {
    await sql`delete from search_alerts where email = ${MATCHER}`;
    await sql`delete from listings where id in (${idA}, ${idB}, ${idC})`;
    await sql`delete from operators where user_id in (select id from users where email = ${OP_EMAIL})`;
    await sql`delete from users where email in (${MATCHER}, ${OP_EMAIL})`;
    await sql.end();
  }
});

test('listing watch: subscribe → confirm → price edit mails update (QA-407)', async () => {
  test.setTimeout(90_000);
  const sql = postgres(testDb);
  const listingId = crypto.randomUUID();
  const WATCHER = `e2e-watch-${run}@test.dev`;

  try {
    const anon = await request.newContext({
      extraHTTPHeaders: { 'fly-client-ip': '10.99.9.10' },
    });
    const op = await login(OP_EMAIL, 'operator');
    const opRes = await op.post('/api/operators', {
      data: { name: `E2E Watch Ops ${run}`, baseAirport: 'LSZH' },
    });
    expect(opRes.status()).toBe(201);
    await sql`
      insert into listings (id, operator_id, vertical, type, title, price_minor, currency, status, attributes, photos)
      select ${listingId}, id, 'jets', 'charter', ${`E2E Watched Jet ${run}`},
             1200000, 'USD', 'active', '{}', '[]'
      from operators where user_id = (select id from users where email = ${OP_EMAIL})`;

    // Watch subscribe — the only param is the listing id.
    const sub = await anon.post('/api/search-alerts', {
      data: { email: WATCHER, params: { watch: listingId } },
    });
    expect(sub.status()).toBe(200);
    const { devConfirmUrl } = (await sub.json()) as { devConfirmUrl?: string };
    const confirmPath = new URL(devConfirmUrl!).pathname +
      new URL(devConfirmUrl!).search;

    // Confirm → redirect lands on the LISTING page.
    const conf = await anon.get(confirmPath, { maxRedirects: 0 });
    expect(conf.headers()['location']).toContain(`/listing/${listingId}`);
    expect(conf.headers()['location']).toContain('alert=confirmed');

    // A price edit is the watch event — mail carries update copy.
    const cut = await op.patch(`/api/listings/${listingId}`, {
      data: { price: 9000 },
    });
    expect(cut.status()).toBe(200);
    let mail: string | null = null;
    for (let i = 0; i < 20 && !mail; i++) {
      mail = latestMailTo(WATCHER);
      if (!mail || !mail.includes('you watch')) mail = null;
      if (!mail) await new Promise((r) => setTimeout(r, 500));
    }
    expect(mail, 'expected a watch update mail').toBeTruthy();
    expect(mail!).toContain(`E2E Watched Jet ${run}`);

    // Editing a DIFFERENT listing leaves the watcher silent.
    const otherId = crypto.randomUUID();
    await sql`
      insert into listings (id, operator_id, vertical, type, title, price_minor, currency, status, attributes, photos)
      select ${otherId}, id, 'jets', 'charter', ${`E2E Unwatched ${run}`},
             500000, 'USD', 'active', '{}', '[]'
      from operators where user_id = (select id from users where email = ${OP_EMAIL})`;
    await op.patch(`/api/listings/${otherId}`, { data: { price: 1 } });
    await new Promise((r) => setTimeout(r, 1500));
    const stale = latestMailTo(WATCHER);
    expect(stale && stale.includes(`E2E Unwatched ${run}`)).toBeFalsy();

    // QA-411: /rfq/thanks offers a watch CTA for a real RFQ — the form's
    // params embed the listing id, and the buyer's email prefills.
    const rfqRes = await anon.post('/api/rfqs', {
      data: {
        listingId,
        buyerEmail: WATCHER,
        fields: {
          departure: 'ZRH',
          arrival: 'LTN',
          dateFrom: isoDateIn(20),
          dateTo: isoDateIn(21),
          passengers: 4,
          name: 'E2E Watch',
          email: WATCHER,
        },
      },
    });
    expect(rfqRes.status()).toBe(201);
    const { rfqId } = (await rfqRes.json()) as { rfqId: string };
    const thanks = await anon.get(
      `/rfq/thanks?id=${rfqId}&email=${encodeURIComponent(WATCHER)}`,
    );
    expect(thanks.status()).toBe(200);
    const thanksHtml = await thanks.text();
    expect(thanksHtml).toContain('thanks-watch');
    // The RSC payload serializes params as watch\":\"<id>\" (escaped quotes).
    expect(thanksHtml).toContain(`watch\\":\\"${listingId}`);

    // QA-408: archiving is terminal — one "watch ended" mail, alert flips off.
    const arch = await op.patch(`/api/listings/${listingId}`, {
      data: { status: 'archived' },
    });
    expect(arch.status()).toBe(200);
    let ended: string | null = null;
    for (let i = 0; i < 20 && !ended; i++) {
      // Scan every mail to the watcher — QA-500's orphan sweep also mails
      // them "request closed" for the RFQ they filed, and it lands AFTER
      // the watch-ended mail, so latest-only lookups miss the real one.
      ended = allMailTo(WATCHER).find((m) => m.includes('watch ended')) ?? null;
      if (!ended) await new Promise((r) => setTimeout(r, 500));
    }
    expect(ended, 'expected a watch-ended mail').toBeTruthy();
    const [alertRow] = await sql`
      select status from search_alerts where email = ${WATCHER}`;
    expect(alertRow?.status).toBe('off');
  } finally {
    await sql`delete from search_alerts where email = ${`e2e-watch-${run}@test.dev`}`;
    await sql`delete from rfq_matches where rfq_id in (select id from rfqs where buyer_email = ${`e2e-watch-${run}@test.dev`})`;
    await sql`delete from rfqs where buyer_email = ${`e2e-watch-${run}@test.dev`}`;
    await sql`delete from listings where title like ${`E2E Watch%${run}`} or title like ${`E2E Unwatched ${run}`}`;
    await sql`delete from operators where user_id in (select id from users where email = ${OP_EMAIL})`;
    await sql`delete from users where email in (${OP_EMAIL})`;
    await sql.end();
  }
});

test('saved searches manageable on /account with a session (QA-473)', async () => {
  const sql = postgres(testDb);
  const ACCT = `e2e-acct-alert-${run}@jetmarket.local`;
  const OTHER = `e2e-acct-other-${run}@jetmarket.local`;
  try {
    const anon = await request.newContext({
      extraHTTPHeaders: { 'fly-client-ip': '10.99.9.9' },
    });
    const sub = await anon.post('/api/search-alerts', {
      data: { email: ACCT, params: { type: 'charter' } },
    });
    expect(sub.status()).toBe(200);
    const [alert] = await sql`
      select id from search_alerts where email = ${ACCT}`;
    expect(alert?.id).toBeTruthy();
    const alertId = alert!.id as string;

    // Session auth (no bearer token) — the mailbox owner sees their row.
    const buyer = await login(ACCT);
    const html1 = await (await buyer.get('/en/account')).text();
    expect(html1).toContain(`account-alert-${alertId}`);
    expect(html1).toContain(`account-alert-status-${alertId}`);
    expect(html1).toContain(`alert-off-${alertId}`);
    // QA-476: a pending row offers resend — re-subscribing the same params
    // is the documented path (dedupe rotates the token, re-mails confirm).
    expect(html1).toContain(`alert-resend-${alertId}`);
    const resend = await buyer.post('/api/search-alerts', {
      data: { email: ACCT, params: { type: 'charter' } },
    });
    expect(resend.status()).toBe(200);
    const resendJson = (await resend.json()) as {
      created: boolean;
      devConfirmUrl?: string;
    };
    expect(resendJson.created).toBe(false);
    expect(resendJson.devConfirmUrl).toContain('/api/search-alerts/confirm?token=');

    // Session POST off — no ?email / token needed; session is the proof.
    const off = await buyer.post(`/api/search-alerts/${alertId}/off`);
    expect(off.status()).toBe(200);
    const [row] = await sql`
      select status from search_alerts where id = ${alertId}`;
    expect(row?.status).toBe('off');
    const html2 = await (await buyer.get('/en/account')).text();
    expect(html2).toContain(`account-alert-${alertId}`);
    expect(html2).not.toContain(`alert-off-${alertId}`);

    // A different signed-in mailbox can't touch the row — 404, not leaked.
    const other = await login(OTHER);
    expect((await other.post(`/api/search-alerts/${alertId}/off`)).status()).toBe(404);

    // QA-478: the saved set deep-links back to /search (re-run + refine =
    // the edit path); the link survives the 'off' state (re-subscribing
    // re-arms). href is locale-prefixed by the i18n Link.
    const openHref = html2.match(
      new RegExp(`data-testid="account-alert-open-${alertId}"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*data-testid="account-alert-open-${alertId}"`),
    );
    const href = openHref?.[1] ?? openHref?.[2] ?? '';
    expect(href).toContain('/search?');
    expect(decodeURIComponent(href)).toContain('type=charter');

    // QA-478: a signed-in buyer's subscribe form pre-fills their session
    // email — no retyping the mailbox the session already proves.
    const searchHtml = await (await buyer.get('/en/search?type=charter')).text();
    expect(searchHtml).toContain(`value="${ACCT}"`);
  } finally {
    await sql`delete from search_alerts where email in (${ACCT}, ${OTHER})`;
    await sql`delete from users where email in (${ACCT}, ${OTHER})`;
    await sql.end();
  }
});

test('saved search pause/resume on /account keeps the row (QA-542)', async () => {
  const sql = postgres(testDb);
  const PAUSE = `e2e-alertpause-${run}@jetmarket.local`;
  try {
    // Subscribe + confirm to reach 'active' — pause is meaningless on
    // pending (it 409s by design).
    const anon = await request.newContext({
      extraHTTPHeaders: { 'fly-client-ip': '10.99.9.10' },
    });
    const sub = await anon.post('/api/search-alerts', {
      data: { email: PAUSE, params: { type: 'charter' } },
    });
    expect(sub.status()).toBe(200);
    const { devConfirmUrl } = (await sub.json()) as {
      devConfirmUrl: string;
    };
    const conf = await anon.get(devConfirmUrl, { maxRedirects: 0 });
    expect(conf.status()).toBeLessThan(400);
    const [alert] = await sql`
      select id, status from search_alerts where email = ${PAUSE}`;
    expect(alert?.status).toBe('active');
    const alertId = alert!.id as string;

    const buyer = await login(PAUSE);
    const html1 = await (await buyer.get('/en/account')).text();
    expect(html1).toContain(`alert-pause-${alertId}`);
    expect(html1).not.toContain(`alert-resume-${alertId}`);

    // Session POST pause — row stays, mail eligibility drops.
    expect(
      (await buyer.post(`/api/search-alerts/${alertId}/pause`)).status(),
    ).toBe(200);
    const [paused] = await sql`
      select status from search_alerts where id = ${alertId}`;
    expect(paused?.status).toBe('paused');
    // Replay + wrong-direction flips 409 instead of silently flipping.
    expect(
      (await buyer.post(`/api/search-alerts/${alertId}/pause`)).status(),
    ).toBe(409);
    const html2 = await (await buyer.get('/en/account')).text();
    expect(html2).toContain(`alert-resume-${alertId}`);

    // Resume puts it back to live delivery.
    expect(
      (await buyer.post(`/api/search-alerts/${alertId}/resume`)).status(),
    ).toBe(200);
    const [resumed] = await sql`
      select status from search_alerts where id = ${alertId}`;
    expect(resumed?.status).toBe('active');
    expect(
      (await buyer.post(`/api/search-alerts/${alertId}/resume`)).status(),
    ).toBe(409);

    // Paused is not a cage — the unsubscribe kill switch still reaches it.
    await buyer.post(`/api/search-alerts/${alertId}/pause`);
    expect(
      (await buyer.post(`/api/search-alerts/${alertId}/off`)).status(),
    ).toBe(200);
    const [final] = await sql`
      select status from search_alerts where id = ${alertId}`;
    expect(final?.status).toBe('off');
  } finally {
    await sql`delete from search_alerts where email = ${PAUSE}`;
    await sql`delete from users where email = ${PAUSE}`;
    await sql.end();
  }
});
