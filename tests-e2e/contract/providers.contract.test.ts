// Adapter-level contract tests: our real.ts impls talk to the compose
// services — StripePaymentsProvider vs stripe-mock (STRIPE_API_BASE) and
// SmtpEmailProvider vs Mailpit (SMTP_URL / MAILPIT_API_URL). Global setup
// probes reachability via inject(), so the suite skips cleanly offline.
//
//   pnpm db:up && pnpm test:contract
import { describe, expect, inject, it } from 'vitest';
import { StripePaymentsProvider } from '@jetmarket/providers/payments/index';
import {
  createEmailProvider,
  SmtpEmailProvider,
} from '@jetmarket/providers/email/index';
import { SERVICES } from './services';

const stripeUp = inject('stripeMockUp');
const mailpitUp = inject('mailpitUp');

describe.skipIf(!stripeUp)('stripe adapter contract (stripe-mock)', () => {
  const payments = new StripePaymentsProvider({
    secretKey: 'sk_test_123',
    apiBase: SERVICES.stripeMock.url,
  });

  it('creates a subscription checkout session', async () => {
    const s = await payments.createCheckoutSession({
      operatorId: 'op1',
      plan: 'pro',
      amountMinor: 19_900,
      currency: 'usd',
      successUrl: 'http://localhost:3000/billing?ok=1',
      cancelUrl: 'http://localhost:3000/billing?ok=0',
    });
    expect(s.id).toMatch(/^cs_/);
    expect(typeof s.url).toBe('string');
  });

  it('creates a billing portal session', async () => {
    const p = await payments.createPortalSession({
      customerId: 'cus_mock',
      returnUrl: 'http://localhost:3000/billing',
    });
    expect(p.url.length).toBeGreaterThan(0);
  });

  it('creates a success-fee invoice (send_invoice collection)', async () => {
    const inv = await payments.createInvoice({
      customerId: 'cus_mock',
      amountMinor: 28_200,
      currency: 'usd',
      description: 'JetMarket success fee — deal d1',
      metadata: { dealId: 'd1' },
      idempotencyKey: 'contract-test-1',
    });
    expect(inv.id).toMatch(/^in_/);
    expect(inv.amountMinor).toBe(28_200);
  });
});

interface MailpitList {
  messages: { ID: string; To: { Address: string }[] }[];
}

describe.skipIf(!mailpitUp)('smtp adapter contract (mailpit)', () => {
  it('sends via SMTP_URL and the message lands in Mailpit', async () => {
    const email = new SmtpEmailProvider({
      smtpUrl: 'smtp://localhost:1025',
      from: 'JetMarket <noreply@jetmarket.local>',
    });
    const to = `adapter-${Date.now()}@jetmarket.local`;
    const sent = await email.send({
      to,
      subject: 'Adapter contract',
      text: 'Magic link: http://localhost:3000/verify?token=x',
    });
    expect(sent.id).toBeTruthy();

    const api = SERVICES.mailpit.url;
    let found: { ID: string } | undefined;
    for (let i = 0; i < 20 && !found; i++) {
      const res = await fetch(`${api}/api/v1/messages?limit=50`);
      const list = (await res.json()) as MailpitList;
      found = list.messages.find((m) =>
        (m.To ?? []).some((t) => t.Address === to),
      );
      if (!found) await new Promise((r) => setTimeout(r, 150));
    }
    expect(found, 'smtp adapter message delivered to mailpit').toBeTruthy();
  });

  it('QA-21: sends carry a From header even with no EMAIL_FROM configured', async () => {
    // createEmailProvider applies the central default (EMAIL_FROM -> site
    // contact) — callers never set `from` today, real relays reject missing.
    const email = createEmailProvider({
      EMAIL_PROVIDER: 'smtp',
      SMTP_URL: 'smtp://localhost:1025',
    });
    const to = `from-contract-${Date.now()}@jetmarket.local`;
    await email.send({ to, subject: 'From check', text: 'has a sender' });

    const api = SERVICES.mailpit.url;
    let found: { ID: string } | undefined;
    for (let i = 0; i < 20 && !found; i++) {
      const res = await fetch(`${api}/api/v1/messages?limit=50`);
      const list = (await res.json()) as MailpitList;
      found = list.messages.find((m) =>
        (m.To ?? []).some((t) => t.Address === to),
      );
      if (!found) await new Promise((r) => setTimeout(r, 150));
    }
    expect(found, 'mail delivered to mailpit').toBeTruthy();

    const full = await fetch(`${api}/api/v1/message/${found!.ID}`);
    const msg = (await full.json()) as {
      From?: { Name?: string; Address?: string };
    };
    // Mailpit parses headers into a structure — assert sender + display name
    // (a real relay only needs the address; the name proves the envelope).
    expect(msg.From?.Address).toBe('noreply@jetmarket.local');
    expect(msg.From?.Name).toBe('JetMarket');
  });
});
