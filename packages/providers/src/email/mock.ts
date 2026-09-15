import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EmailMessage, EmailProvider, SentEmail } from "./types";

export interface MockEmailOptions {
  /** Outbox dir (EMAIL_OUTBOX_DIR; default tmp/outbox). */
  outboxDir?: string;
  /** Default From header (EMAIL_FROM). */
  from?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export const DEFAULT_OUTBOX_DIR = "tmp/outbox";

/**
 * Mock email: writes each message as `<id>.eml` (RFC-822-ish) and `<id>.json`
 * (parsed fields) under the outbox dir. Deterministic, inspectable offline.
 */
export class MockEmailProvider implements EmailProvider {
  private readonly dir: string;
  private readonly from: string;
  private readonly now: () => Date;

  constructor(opts: MockEmailOptions = {}) {
    this.dir = opts.outboxDir ?? DEFAULT_OUTBOX_DIR;
    this.from = opts.from ?? "JetMarket <noreply@jetmarket.local>";
    this.now = opts.now ?? (() => new Date());
  }

  async send(message: EmailMessage): Promise<SentEmail> {
    if (!message.text && !message.html) {
      throw new Error("email requires text or html body");
    }
    const at = this.now();
    const id = `${at.getTime().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    const from = message.from ?? this.from;
    mkdirSync(this.dir, { recursive: true });
    const eml = [
      `From: ${from}`,
      `To: ${message.to}`,
      message.replyTo ? `Reply-To: ${message.replyTo}` : null,
      `Subject: ${message.subject}`,
      `Date: ${at.toUTCString()}`,
      message.html ? `Content-Type: text/html; charset=utf-8` : `Content-Type: text/plain; charset=utf-8`,
      ``,
      message.html ?? message.text ?? ``,
    ]
      .filter((l): l is string => l !== null)
      .join("\r\n");
    writeFileSync(join(this.dir, `${id}.eml`), eml);
    writeFileSync(
      join(this.dir, `${id}.json`),
      JSON.stringify({ id, ...message, from, at: at.toISOString() }, null, 2),
    );
    return { id, to: message.to, subject: message.subject, at: at.toISOString() };
  }
}

/** Read all mock-sent messages from an outbox dir (tests / dev tooling). */
export function readOutbox(
  outboxDir = DEFAULT_OUTBOX_DIR,
): (EmailMessage & { id: string; from: string; at: string })[] {
  let files: string[];
  try {
    files = readdirSync(outboxDir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(outboxDir, f), "utf8")) as EmailMessage & { id: string; from: string; at: string });
}
