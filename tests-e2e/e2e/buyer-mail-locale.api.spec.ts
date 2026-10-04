import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, request, test } from '@playwright/test';

/**
 * QA-493: buyer-facing mail follows the artifact's stamped locale.
 * RFQ create stamps `rfqs.locale` from the (already-locale-aware) page, and
 * every buyer mail keyed off that RFQ — plus alert mails off
 * `search_alerts.locale` and the transient magic-link locale — renders from
 * `mail.*` in that catalog. This spec pins the de path end-to-end through
 * the mock outbox (.eml files).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const OUTBOX_DIRS = [
  path.join(repoRoot, 'apps', 'web', 'tmp', 'outbox'),
  path.join(repoRoot, 'tmp', 'outbox'),
];

const run = Date.now().toString(36);
const BUYER_DE = `e2e-de-buyer-${run}@jetmarket.local`;
const BUYER_EN = `e2e-en-buyer-${run}@jetmarket.local`;
const ALERT_DE = `e2e-de-alert-${run}@jetmarket.local`;
const LOGIN_DE = `e2e-de-login-${run}@jetmarket.local`;

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

test('buyer mails follow the stamped locale (QA-493)', async () => {
  const ctx = await request.newContext({
    extraHTTPHeaders: { 'fly-client-ip': '10.99.93.93' },
  });

  // RFQ stamped 'de' → confirmation mail is German.
  const lres = await ctx.get('/api/listings?limit=1');
  const listing = (await lres.json())[0];
  const fields = {
    departure: 'ZRH',
    arrival: 'NCE',
    dateFrom: '2030-01-10',
    dateTo: '2030-01-12',
    passengers: 2,
    name: 'De Buyer',
    email: BUYER_DE,
    phone: '+41 44 000 00 00',
  };
  const de = await ctx.post('/api/rfqs', {
    data: { listingId: listing.id, buyerEmail: BUYER_DE, fields, locale: 'de' },
  });
  expect(de.status()).toBe(201);
  const deMail = await waitForMail(BUYER_DE, 'Ihre Anfrage');
  expect(deMail).toContain('Ihre Anfrage');
  expect(deMail).toContain('Wir haben Ihre Anfrage');
  expect(deMail).not.toContain('Your request for');

  // Same flow without a locale stamp → English (default 'en').
  const en = await ctx.post('/api/rfqs', {
    data: { listingId: listing.id, buyerEmail: BUYER_EN, fields: { ...fields, email: BUYER_EN } },
  });
  expect(en.status()).toBe(201);
  const enMail = await waitForMail(BUYER_EN, 'Your request for');
  expect(enMail).toContain('Your request for');
  expect(enMail).toContain('We sent your request');

  // Saved-search confirm mail in the alert's stamped locale.
  const sub = await ctx.post('/api/search-alerts', {
    data: {
      email: ALERT_DE,
      params: { type: 'charter' },
      freq: 'instant',
      locale: 'de',
    },
  });
  expect(sub.status()).toBe(200);
  const alertMail = await waitForMail(ALERT_DE, 'gespeicherte Suche');
  expect(alertMail).toContain('gespeicherte Suche');
  expect(alertMail).toContain('Bestätigen Sie');

  // Magic-link mail keeps the page locale via the body field.
  const ml = await ctx.post('/api/auth/magic-link', {
    data: { email: LOGIN_DE, role: 'buyer', locale: 'de' },
  });
  expect(ml.ok()).toBeTruthy();
  const loginMail = await waitForMail(LOGIN_DE, 'Anmeldelink');
  expect(loginMail).toContain('Anmeldelink');

  await ctx.dispose();
});
