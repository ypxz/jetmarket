// Buyer RFQ amendment (QA-481): PATCH /api/rfqs/[id] replaces a live
// request's fields, re-keys the dedupe map (collision → 409), and mails
// the pre-amend delivered set (here: the listing owner — e2e has no
// worker draining fan-out jobs, so no match holders exist).
// Session-authed buyers need no bearer token (QA-474); strangers 404.
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import postgres from 'postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoDateIn, signUpAndLogin } from '../helpers/flow';

test.use({ extraHTTPHeaders: { 'fly-client-ip': '10.99.8.8' } });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const OUTBOX_DIRS = [
  path.join(repoRoot, 'apps', 'web', 'tmp', 'outbox'),
  path.join(repoRoot, 'tmp', 'outbox'),
];

const run = Date.now().toString(36);
const OP_EMAIL = `e2e-amend-op-${run}@jetmarket.local`;
const BUYER = `e2e-amend-buyer-${run}@jetmarket.local`;
const STRANGER = `e2e-amend-stranger-${run}@jetmarket.local`;

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

async function login(email: string, role: 'buyer' | 'operator' = 'buyer') {
  const ctx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.8.8' },
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

function rfqFields(email: string, over: Record<string, unknown> = {}) {
  return {
    departure: 'ZRH',
    arrival: 'NCE',
    dateFrom: isoDateIn(14),
    dateTo: isoDateIn(16),
    passengers: 4,
    name: 'Amend Buyer',
    email,
    ...over,
  };
}

async function mkRfq(
  publicCtx: APIRequestContext,
  listingId: string,
  email: string,
  fields?: Record<string, unknown>,
) {
  const res = await publicCtx.post('/api/rfqs', {
    data: {
      listingId,
      buyerEmail: email,
      fields: fields ?? rfqFields(email),
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { rfqId: string; accessToken: string };
}

test('buyer amendment: PATCH replaces fields, re-keys dedupe, mails owner (QA-481)', async ({ page }) => {
  test.setTimeout(90_000);
  const sql = postgres(testDb, { max: 1 });
  const publicCtx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.8.8' },
  });
  let listingId = '';
  const rfqIds: string[] = [];
  try {
    const operator = await login(OP_EMAIL, 'operator');
    expect(
      (
        await operator.post('/api/operators', {
          data: { name: `E2E Amend Ops ${run}`, baseAirport: 'LSZH' },
        })
      ).status(),
    ).toBe(201);
    const lres = await operator.post('/api/listings', {
      data: {
        type: 'charter',
        title: `E2E Amend Charter ${run}`,
        price: 38000,
        currency: 'USD',
        photos: [],
        attributes: {},
      },
    });
    expect(lres.status()).toBe(201);
    listingId = ((await lres.json()) as { id: string }).id;

    // The amendable request + a live twin whose details we'll collide with.
    const rfq = await mkRfq(publicCtx, listingId, BUYER);
    rfqIds.push(rfq.rfqId);
    const twinFields = rfqFields(BUYER, { passengers: 8, name: 'Twin Buyer' });
    const twin = await mkRfq(publicCtx, listingId, BUYER, twinFields);
    rfqIds.push(twin.rfqId);

    const buyer = await login(BUYER);

    // 1. Happy path — session PATCH replaces the field map wholesale.
    const newFields = rfqFields(BUYER, { departure: 'GVA', passengers: 6 });
    const patch = await buyer.patch(`/api/rfqs/${rfq.rfqId}`, {
      data: { buyerEmail: BUYER, fields: newFields },
    });
    expect(patch.status()).toBe(200);
    expect(((await patch.json()) as { amended?: boolean }).amended).toBe(true);

    // The inbox echo reflects the new details immediately.
    const inbox = await buyer.get('/api/buyer/quotes');
    expect(inbox.ok()).toBeTruthy();
    const rows = (await inbox.json()) as {
      id: string;
      requestFields: { label: string; value: string }[];
    }[];
    const echo = rows
      .find((r) => r.id === rfq.rfqId)
      ?.requestFields.map((f) => f.value) ?? [];
    expect(echo).toContain('GVA');
    expect(echo).not.toContain('ZRH');

    // 2. The listing owner got the "Updated RFQ" mail (the delivered set is
    // just them — no worker drains fan-out jobs inside e2e).
    let mail: string | null = null;
    for (let i = 0; i < 20 && !mail; i++) {
      mail = latestMailTo(OP_EMAIL);
      if (mail && !mail.includes('Updated RFQ')) mail = null;
      if (!mail) await new Promise((r) => setTimeout(r, 500));
    }
    expect(mail, 'expected an Updated RFQ mail to the listing owner').toBeTruthy();
    expect(mail!).toContain('GVA');
    // QA-482 — the mail leads with the old → new diff, not the full dump.
    expect(mail!).toContain('what changed');
    expect(mail!).toContain('Departure: ZRH → GVA');
    expect(mail!).toContain('Passengers: 4 → 6');

    // 3. Dedupe collision — amending to the twin's exact live details takes
    // the twin's dedupe key → 409, no write.
    expect(
      (
        await buyer.patch(`/api/rfqs/${rfq.rfqId}`, {
          data: { buyerEmail: BUYER, fields: twinFields },
        })
      ).status(),
    ).toBe(409);

    // 3b. Operator-side "Updated" signal (QA-482) — the API flag marks the
    // amended request (op never visited → compared to createdAt); the twin
    // stays false. Then the UI badge: op opens the inbox (marks seen), we
    // amend once more, and a reload shows the Updated chip.
    const opInbox = await operator.get('/api/operator/rfqs');
    const opRows = (await opInbox.json()) as {
      id: string;
      updatedSinceSeen?: boolean;
    }[];
    expect(opRows.find((r) => r.id === rfq.rfqId)?.updatedSinceSeen).toBe(true);
    expect(opRows.find((r) => r.id === twin.rfqId)?.updatedSinceSeen).toBe(
      false,
    );

    await signUpAndLogin(page, OP_EMAIL, 'operator');
    await page.goto('/app/rfqs');
    await page
      .waitForResponse(
        (r) => r.url().includes('/api/operator/rfqs/seen'),
        { timeout: 30_000 },
      )
      .catch(() => {});
    const again = await buyer.patch(`/api/rfqs/${rfq.rfqId}`, {
      data: {
        buyerEmail: BUYER,
        fields: rfqFields(BUYER, { arrival: 'LIN' }),
      },
    });
    expect(again.status()).toBe(200);
    await page.goto('/app/rfqs');
    await expect(page.getByTestId(`rfq-updated-${rfq.rfqId}`)).toBeVisible({
      timeout: 30_000,
    });
    // Created before that visit — the New badge is gone, only Updated shows.
    await expect(
      page.getByTestId(`rfq-new-${rfq.rfqId}`),
    ).not.toBeVisible();
    // The untouched twin never got a content write — no Updated chip.
    await expect(
      page.getByTestId(`rfq-updated-${twin.rfqId}`),
    ).not.toBeVisible();

    // 4b. Extend mails the delivered set too (QA-484) — an extension is a
    // one-field amendment: the owner gets the same diff mail leading with
    // "Latest date: old → new". Pull dateTo in first so a week buys time.
    expect(
      (
        await buyer.patch(`/api/rfqs/${rfq.rfqId}`, {
          data: {
            buyerEmail: BUYER,
            fields: rfqFields(BUYER, {
              dateFrom: isoDateIn(0),
              dateTo: isoDateIn(2),
            }),
          },
        })
      ).status(),
    ).toBe(200);
    const ext = await buyer.post(`/api/rfqs/${rfq.rfqId}/extend`, {
      data: { buyerEmail: BUYER },
    });
    expect(ext.status()).toBe(200);
    const { dateTo: newDateTo } = (await ext.json()) as { dateTo: string };
    let extMail: string | null = null;
    for (let i = 0; i < 20 && !extMail; i++) {
      const m = latestMailTo(OP_EMAIL);
      // The PATCH above also mailed a Latest-date diff — disambiguate on
      // the extend's forward target.
      if (
        m &&
        m.includes('Updated RFQ') &&
        m.includes('Latest date') &&
        m.includes(`→ ${newDateTo}`)
      ) {
        extMail = m;
      } else {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    expect(extMail, 'expected an Updated RFQ mail after extend').toBeTruthy();
    expect(extMail!).toContain('what changed');

    // 4. A stranger session can't amend — uniform-denial 404.
    const stranger = await login(STRANGER);
    expect(
      (
        await stranger.patch(`/api/rfqs/${rfq.rfqId}`, {
          data: { buyerEmail: BUYER, fields: newFields },
        })
      ).status(),
    ).toBe(404);

    // 5. A terminal row refuses the write — close, then PATCH → 409.
    expect(
      (
        await buyer.post(`/api/rfqs/${rfq.rfqId}/close`, {
          data: { buyerEmail: BUYER },
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await buyer.patch(`/api/rfqs/${rfq.rfqId}`, {
          data: { buyerEmail: BUYER, fields: newFields },
        })
      ).status(),
    ).toBe(409);
  } finally {
    for (const rid of rfqIds) {
      await sql`delete from rfq_matches where rfq_id = ${rid}`;
      await sql`delete from rfqs where id = ${rid}`;
    }
    if (listingId) await sql`delete from listings where id = ${listingId}`;
    await sql`delete from operators where user_id in
      (select id from users where email in (${OP_EMAIL}, ${BUYER}, ${STRANGER}))`;
    await sql`delete from users where email in (${OP_EMAIL}, ${BUYER}, ${STRANGER})`;
    await sql.end();
  }
});
