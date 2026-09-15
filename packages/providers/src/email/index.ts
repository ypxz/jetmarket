import { envOf } from "../env";
import type { Env } from "../env";
import { MockEmailProvider } from "./mock";
import { ResendEmailProvider, SmtpEmailProvider } from "./real";
import type { EmailProvider } from "./types";

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
}

// Singleton survives dev-server HMR via globalThis.
const g = globalThis as unknown as { __jmEmail?: EmailProvider };
export function emailProvider(env?: Env): EmailProvider {
  if (!g.__jmEmail) g.__jmEmail = createEmailProvider(env);
  return g.__jmEmail;
}
