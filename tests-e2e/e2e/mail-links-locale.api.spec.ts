import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, request, test } from '@playwright/test';

/**
 * QA-496: mailed deep-links keep the recipient's locale. A 'de'-stamped RFQ
 * mails `/de/quotes?email=…` (not the bare English path), the confirm-mail's
 * saved-search target + the alert confirm/unsubscribe redirects land under
 * /de, and the magic link's `next` hops back onto /de pages. English rows
 * stay unprefixed (`localePrefix: 'as-needed'`).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const OUTBOX_DIRS = [
  path.join(repoRoot, 'apps', 'web', 'tmp', 'outbox'),
  path.join(repoRoot, 'tmp', 'outbox'),
];

const run = Date.now().toString(36);
const BUYER_DE = `e2e-link-de-${run}@jetmarket.local`;
const BUYER_EN = `e2e-link-en-${run}@jetmarket.local`;
const ALERT_DE = `e2e-link-alert-${run}@jetmarket.local`;
const LOGIN_DE = `e2e-link-login-${run}@jetmarket.local`;

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

async function waitForMail(
  email: string,
  needle: string,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mail = latestMailTo(email);
    if (mail && mail.includes(needle)) return mail;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no mail containing "${needle}" reached ${email}`);
}

test('mailed links keep the recipient locale (QA-496)', async () => {
  const ctx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.96.96' },
  });

  // de-stamped RFQ → confirmation mail deep-links /de/quotes + /de/rfq/thanks.
  const lres = await ctx.get('/api/listings?limit=1');
  const listing = (await lres.json())[0];
  const fields = {
    departure: 'ZRH',
    arrival: 'NCE',
    dateFrom: '2030-01-10',
    dateTo: '2030-01-12',
    passengers: 2,
    name: 'Link Buyer',
    email: BUYER_DE,
    phone: '+41 44 000 00 00',
  };
  const de = await ctx.post('/api/rfqs', {
    data: { listingId: listing.id, buyerEmail: BUYER_DE, fields, locale: 'de' },
  });
  expect(de.status()).toBe(201);
  const deMail = await waitForMail(BUYER_DE, 'Ihre Anfrage');
  expect(deMail).toContain('/de/quotes?');
  expect(deMail).toContain('/de/rfq/thanks?');

  // Same flow unstamped → English links, no /en prefix (prefix-as-needed).
  const en = await ctx.post('/api/rfqs', {
    data: {
      listingId: listing.id,
      buyerEmail: BUYER_EN,
      fields: { ...fields, email: BUYER_EN },
    },
  });
  expect(en.status()).toBe(201);
  const enMail = await waitForMail(BUYER_EN, 'Your request for');
  expect(enMail).toContain('/quotes?');
  expect(enMail).not.toContain('/de/quotes');
  expect(enMail).not.toContain('/en/quotes');

  // de alert: the confirm mail's saved-search target is already /de, the
  // confirm GET redirects onto it, and the unsubscribe GET does too.
  const sub = await ctx.post('/api/search-alerts', {
    data: {
      email: ALERT_DE,
      params: { type: 'charter' },
      freq: 'instant',
      locale: 'de',
    },
  });
  expect(sub.status()).toBe(200);
  const { devConfirmUrl } = (await sub.json()) as { devConfirmUrl?: string };
  expect(devConfirmUrl).toContain('/api/search-alerts/confirm?token=');
  const token = new URL(devConfirmUrl!).searchParams.get('token')!;
  const alertMail = await waitForMail(ALERT_DE, 'gespeicherte Suche');
  expect(alertMail).toContain('/de/search');

  const confirmPath =
    new URL(devConfirmUrl!).pathname + new URL(devConfirmUrl!).search;
  const conf = await ctx.get(confirmPath, { maxRedirects: 0 });
  expect([301, 302, 303, 307, 308]).toContain(conf.status());
  const confLoc = conf.headers()['location']!;
  expect(confLoc).toContain('/de/search');
  expect(confLoc).toContain('type=charter');
  expect(confLoc).toContain('alert=confirmed');

  const unsub = await ctx.get(
    `/api/search-alerts/unsubscribe?token=${encodeURIComponent(token)}`,
    { maxRedirects: 0 },
  );
  expect([301, 302, 303, 307, 308]).toContain(unsub.status());
  const unsubLoc = unsub.headers()['location']!;
  expect(unsubLoc).toContain('/de/search');
  expect(unsubLoc).toContain('alert=unsubscribed');

  // de magic link → callback `next` hops back onto the localized landing.
  const ml = await ctx.post('/api/auth/magic-link', {
    data: { email: LOGIN_DE, role: 'operator', locale: 'de' },
  });
  expect(ml.ok()).toBeTruthy();
  const { devLink } = (await ml.json()) as { devLink: string };
  expect(devLink).toContain(`next=${encodeURIComponent('/de/app/onboarding')}`);

  await ctx.dispose();
});
