import { envOf } from "../env";
import type { Env } from "../env";
import { MockEmailProvider } from "./mock";
import { ResendEmailProvider, SmtpEmailProvider } from "./real";
import { DEFAULT_FROM, type EmailProvider } from "./types";

export * from "./types";
export { MockEmailProvider, readOutbox } from "./mock";
export { ResendEmailProvider, SmtpEmailProvider } from "./real";

export type EmailProviderName = "mock" | "smtp" | "resend";

export function emailProviderName(env?: Env): EmailProviderName {
  const e = envOf(env);
  const v = (e.EMAIL_PROVIDER ?? "mock").toLowerCase();
  return v === "smtp" || v === "resend" ? v : "mock";
}

/**
 * EMAIL_PROVIDER: mock (default → EMAIL_OUTBOX_DIR/tmp/outbox) | smtp
 * (SMTP_URL — Mailpit on `pnpm db:up` or a real relay) | resend (skeleton).
 */
export function createEmailProvider(env?: Env): EmailProvider {
  const e = envOf(env);
  const adapter = ((): EmailProvider => {
    switch (emailProviderName(e)) {
      case "smtp":
        return new SmtpEmailProvider({
          smtpUrl: e.SMTP_URL ?? "smtp://localhost:1025",
          from: e.EMAIL_FROM,
        });
      case "resend":
        return new ResendEmailProvider({
          apiKey: e.RESEND_API_KEY ?? "",
          from: e.EMAIL_FROM,
        });
      case "mock":
      default:
        return new MockEmailProvider({
          outboxDir: e.EMAIL_OUTBOX_DIR,
          from: e.EMAIL_FROM,
        });
    }
  })();
  // Central sender guarantee (QA-21): every outbound mail carries a From —
  // per-message `from` wins, then EMAIL_FROM, then the site contact. Applied
  // here so any adapter (incl. future ones) can't emit a headerless mail.
  const siteFrom = e.EMAIL_FROM ?? DEFAULT_FROM;
  return {
    send: (m) => adapter.send(m.from ? m : { ...m, from: siteFrom }),
  };
}

// Singleton survives dev-server HMR via globalThis.
const g = globalThis as unknown as { __jmEmail?: EmailProvider };
export function emailProvider(env?: Env): EmailProvider {
  if (!g.__jmEmail) g.__jmEmail = createEmailProvider(env);
  return g.__jmEmail;
}
