export interface CheckoutSessionRequest {
  /** Operator (tenant) being billed — carried in metadata. */
  operatorId: string;
  /** Plan slug from the vertical config (e.g. "pro"). */
  plan: string;
  /** Amount to charge per period; omit for plan-catalog pricing. */
  amountMinor?: number;
  currency?: string;
  email?: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}

export interface CheckoutSession {
  id: string;
  /** Hosted checkout URL to redirect the operator to. */
  url: string;
}

export interface PortalSession {
  url: string;
}

export interface PaymentSessionRequest {
  amountMinor: number;
  currency: string;
  email?: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  /** What the payment buys — e.g. { kind: "concierge", rfqId } — echoed
   *  back on the payment.completed webhook event. */
  metadata?: Record<string, string>;
}

/** Normalized subscription event emitted by handleWebhook. */
export type PaymentEvent =
  | {
      kind: "subscription.activated";
      customerId: string;
      subscriptionId: string;
      metadata?: Record<string, string>;
      /** Provider event time (unix s) — the repo's stale-event gate. */
      created?: number;
    }
  | {
      kind: "subscription.canceled";
      customerId: string;
      subscriptionId: string;
      metadata?: Record<string, string>;
      created?: number;
    }
  | {
      /** One-off payment succeeded (mode=payment checkout) — metadata
       *  carries what was bought ({ kind: "concierge", rfqId }). */
      kind: "payment.completed";
      customerId: string;
      metadata?: Record<string, string>;
      created?: number;
    }
  | { kind: "ignored"; type: string };

export interface InvoiceRequest {
  customerId: string;
  amountMinor: number;
  currency: string;
  description: string;
  /** e.g. { dealId, quoteId } for the success-fee ledger. */
  metadata?: Record<string, string>;
  /** Provider-level idempotency key (stripe Idempotency-Key). */
  idempotencyKey?: string;
}

export interface Invoice {
  id: string;
  /** Hosted page where the operator can pay — stripe hosted_invoice_url. */
  hostedUrl?: string;
  amountMinor: number;
  currency: string;
  status: string;
}

/**
 * Payments: subscription checkout/portal + success-fee invoicing.
 * mock = deterministic instant-success; stripe = SDK vs stripe-mock
 * (STRIPE_API_BASE) or live.
 */
export interface PaymentsProvider {
  createCheckoutSession(req: CheckoutSessionRequest): Promise<CheckoutSession>;
  createPortalSession(opts: {
    customerId: string;
    returnUrl: string;
  }): Promise<PortalSession>;
  /** One-off hosted checkout (mode=payment) — buyer-side charges like
   *  concierge; normalizes to `payment.completed` via the webhook. */
  createPaymentSession(req: PaymentSessionRequest): Promise<CheckoutSession>;
  /** Success-fee invoice — one-off, send_invoice collection. */
  createInvoice(req: InvoiceRequest): Promise<Invoice>;
  /** Verify + normalize a webhook payload (raw body + signature header). */
  handleWebhook(
    payload: string | Uint8Array,
    signature: string | null,
  ): Promise<PaymentEvent>;
}
