// Reads the latest auth/notification email for an address from the mock email
// adapter. Two transports are supported, tried in order every poll:
//   1. tmp/outbox (EMAIL_PROVIDER=mock writes one file per message, .json or .eml)
//   2. Mailpit HTTP API (EMAIL_PROVIDER=smtp against `pnpm db:up` mailpit)
// Contract for the app workers is documented in tests-e2e/TESTIDS.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const OUTBOX_DIRS = [
  path.join(repoRoot, 'tmp', 'outbox'),
  path.join(repoRoot, 'apps', 'web', 'tmp', 'outbox'),
  path.join(repoRoot, 'apps', 'web', '.tmp', 'outbox'),
  path.join(repoRoot, 'outbox'),
];

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

function extractLink(text: string): string | null {
  const links = text.match(URL_RE) ?? [];
  return (
    links.find((u) => /auth|magic|verify|token|login/i.test(u)) ??
    links[0] ??
    null
  );
}

function readOutboxFiles(email: string): string | null {
  for (const dir of OUTBOX_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .map((f) => path.join(dir, f))
      .filter((f) => fs.statSync(f).isFile())
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const file of files) {
      const body = fs.readFileSync(file, 'utf8');
      if (!body.toLowerCase().includes(email.toLowerCase())) continue;
      const link = extractLink(body);
      if (link) return link;
    }
  }
  return null;
}

interface MailpitMessage {
  ID: string;
  To: { Address: string }[];
}

async function readMailpit(email: string): Promise<string | null> {
  const api = process.env.MAILPIT_API_URL;
  if (!api) return null;
  try {
    const res = await fetch(`${api}/api/v1/messages?limit=50`);
    if (!res.ok) return null;
    const data = (await res.json()) as { messages?: MailpitMessage[] };
    const match = (data.messages ?? []).find((m) =>
      (m.To ?? []).some((t) => t.Address.toLowerCase() === email.toLowerCase()),
    );
    if (!match) return null;
    const full = await fetch(`${api}/api/v1/message/${match.ID}`);
    if (!full.ok) return null;
    const body = await full.text();
    return extractLink(body);
  } catch {
    return null;
  }
}

export async function waitForEmailLink(
  email: string,
  { timeoutMs = 15_000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const link = readOutboxFiles(email) ?? (await readMailpit(email));
    if (link) return link;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `no email with a link for ${email} within ${timeoutMs}ms ` +
      `(checked ${OUTBOX_DIRS.join(', ')}${process.env.MAILPIT_API_URL ? ` and ${process.env.MAILPIT_API_URL}` : ''})`,
  );
}
