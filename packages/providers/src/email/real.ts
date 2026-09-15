import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { todoGoLive } from "../errors";
import type { EmailMessage, EmailProvider, SentEmail } from "./types";

/**
 * SMTP email via nodemailer — works against the compose Mailpit
 * (SMTP_URL=smtp://localhost:1025) or any real relay.
 */
export class SmtpEmailProvider implements EmailProvider {
  private readonly transport: Transporter;
  private readonly from?: string;

  constructor(opts: { smtpUrl: string; from?: string }) {
    this.transport = nodemailer.createTransport(opts.smtpUrl);
    this.from = opts.from;
  }

  async send(message: EmailMessage): Promise<SentEmail> {
    if (!message.text && !message.html) {
      throw new Error("email requires text or html body");
    }
    const info = await this.transport.sendMail({
      from: message.from ?? this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: message.replyTo,
      headers: message.tags
        ? Object.fromEntries(
            Object.entries(message.tags).map(([k, v]) => [`X-Tag-${k}`, v]),
          )
        : undefined,
    });
    return {
      id: info.messageId ?? `smtp-${Date.now()}`,
      to: message.to,
      subject: message.subject,
      at: new Date().toISOString(),
    };
  }
}

export interface ResendEmailOptions {
  apiKey: string; // RESEND_API_KEY
  from?: string;
}

/**
 * Resend API email. TODO(go-live): typed skeleton — verify request/response
 * shapes against https://resend.com/docs/api-reference/emails/send-email
 * once a key exists; the fetch call is standard REST so this should drop in.
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
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: message.from ?? this.opts.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
        reply_to: message.replyTo,
        tags: message.tags
          ? Object.entries(message.tags).map(([name, value]) => ({ name, value }))
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
      subject: message.subject,
      at: new Date().toISOString(),
    };
  }
}
