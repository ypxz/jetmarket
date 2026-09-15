// Contract example: the email adapter's real.ts sends via SMTP_URL (Mailpit in
// compose); tests read the captured mail back via Mailpit's HTTP API
// (MAILPIT_API_URL). smtpSend is the dep-free client other packages can reuse.
//
//   pnpm db:up            # starts Mailpit (SMTP :1025, API :8025)
//   pnpm test:contract
import { describe, expect, inject, it } from 'vitest';
import { SERVICES } from './services';
import { smtpSend } from './smtp';

const api = SERVICES.mailpit.url;
const up = inject('mailpitUp');

interface MailpitList {
  messages: { ID: string; To: { Address: string }[]; Subject: string }[];
}

describe.skipIf(!up)('mailpit contract', () => {
  it('accepts an SMTP message and serves it over the HTTP API', async () => {
    const to = `contract-${Date.now()}@jetmarket.local`;
    await smtpSend({
      from: 'noreply@jetmarket.local',
      to,
      subject: 'Contract test',
      text: 'Magic link: https://jetmarket.local/api/auth/callback?token=abc123',
    });

    // read back via Mailpit API (poll — delivery is async but local-fast)
    let found: { ID: string } | undefined;
    for (let i = 0; i < 20 && !found; i++) {
      const res = await fetch(`${api}/api/v1/messages?limit=50`);
      expect(res.ok).toBeTruthy();
      const list = (await res.json()) as MailpitList;
      found = list.messages.find((m) =>
        (m.To ?? []).some((t) => t.Address === to),
      );
      if (!found) await new Promise((r) => setTimeout(r, 150));
    }
    expect(found, 'message delivered to mailpit').toBeTruthy();

    const full = await fetch(`${api}/api/v1/message/${found!.ID}`);
    expect(full.ok).toBeTruthy();
    const text = await full.text();
    expect(text).toContain('/api/auth/callback?token=');

    // cleanup so repeat runs stay deterministic
    await fetch(`${api}/api/v1/message/${found!.ID}`, { method: 'DELETE' });
  });
});
