import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { todoGoLive } from "../errors";
import {
  DEFAULT_FROM,
  sanitizeHeaderValue,
  type EmailMessage,
  type EmailProvider,
  type SentEmail,
} from "./types";

/**
 * SMTP email via nodemailer — works against the compose Mailpit
 * (SMTP_URL=smtp://localhost:1025) or any real relay.
 */
// nodemailer's URL shorthand can't carry connection options — translate it so
// a hung relay fails fast instead of stalling the awaiting route/worker on
// the multi-minute socket defaults (Resend's fetch already bounds at 15s).
function smtpUrlToOptions(url: string) {
  const u = new URL(url);
  const secure = u.protocol === "smtps:";
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : secure ? 465 : 587,
    secure,
    ...(u.username
      ? {
          auth: {
            user: decodeURIComponent(u.username),
            pass: decodeURIComponent(u.password),
          },
        }
      : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  };
}

export class SmtpEmailProvider implements EmailProvider {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(opts: { smtpUrl: string; from?: string }) {
    this.transport = nodemailer.createTransport(smtpUrlToOptions(opts.smtpUrl));
    // Default sender — Mailpit tolerates a missing From but real relays
    // reject it; EMAIL_FROM overrides, per-message `from` wins over both.
    this.from = opts.from ?? DEFAULT_FROM;
  }

  async send(message: EmailMessage): Promise<SentEmail> {
    if (!message.text && !message.html) {
      throw new Error("email requires text or html body");
    }
    const info = await this.transport.sendMail({
      from: sanitizeHeaderValue(message.from ?? this.from),
      to: sanitizeHeaderValue(message.to),
      subject: sanitizeHeaderValue(message.subject),
      text: message.text,
      html: message.html,
      replyTo: message.replyTo && sanitizeHeaderValue(message.replyTo),
      headers: message.tags
        ? Object.fromEntries(
            Object.entries(message.tags).map(([k, v]) => [
              `X-Tag-${k}`,
              sanitizeHeaderValue(v),
            ]),
          )
        : undefined,
    });
    return {
      id: info.messageId ?? `smtp-${Date.now()}`,
      to: message.to,
      subject: sanitizeHeaderValue(message.subject),
      at: new Date().toISOString(),
    };
  }
}

export interface ResendEmailOptions {
  apiKey: string; // RESEND_API_KEY
  from?: string;
}

/**
 * Resend API email. Request/response verified against the OpenAPI spec
 * (resendlabs/resend-openapi SendEmailRequest: from, to[], subject, text,
 * html, reply_to, tags[{name,value}]) — drops in once RESEND_API_KEY exists.
 */
export class ResendEmailProvider implements EmailProvider {
  constructor(readonly opts: ResendEmailOptions) {}

  async send(message: EmailMessage): Promise<SentEmail> {
    if (!this.opts.apiKey) {
      throw todoGoLive(
        "resend",
        "send (missing RESEND_API_KEY)",
        "https://resend.com/docs/api-reference/emails/send-email",
      );
    }
    // Bounded wait — a hung resend connection would stall the worker job
    // indefinitely otherwise (same reasoning as the captcha fetch, QA-170).
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: sanitizeHeaderValue(message.from ?? this.opts.from ?? DEFAULT_FROM),
        to: [sanitizeHeaderValue(message.to)],
        subject: sanitizeHeaderValue(message.subject),
        text: message.text,
        html: message.html,
        reply_to: message.replyTo && sanitizeHeaderValue(message.replyTo),
        tags: message.tags
          ? Object.entries(message.tags).map(([name, value]) => ({
              name,
              value: sanitizeHeaderValue(value),
            }))
          : undefined,
      }),
    });
    if (!res.ok) {
      throw new Error(`resend send failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { id?: string };
    return {
      id: body.id ?? `resend-${Date.now()}`,
      to: message.to,
      subject: sanitizeHeaderValue(message.subject),
      at: new Date().toISOString(),
    };
  }
}
