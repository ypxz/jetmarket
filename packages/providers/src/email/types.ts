export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body; at least one of text/html required. */
  text?: string;
  html?: string;
  /** RFC-822 sender, e.g. "JetMarket <noreply@jetmarket.local>". */
  from?: string;
  replyTo?: string;
  /** Free-form tags for provider-side filtering. */
  tags?: Record<string, string>;
}

export interface SentEmail {
  /** Provider-assigned id (mock: filename stem). */
  id: string;
  to: string;
  subject: string;
  /** ISO send time. */
  at: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<SentEmail>;
}
