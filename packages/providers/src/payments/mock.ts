import { randomBytes } from "node:crypto";
import type {
  CheckoutSession,
  CheckoutSessionRequest,
  Invoice,
  InvoiceRequest,
  PaymentEvent,
  PaymentsProvider,
  PortalSession,
} from "./types";

export interface MockPaymentsOptions {
  /** Base for hosted URLs (APP_URL). */
  appUrl?: string;
  /** Injectable id/entropy for deterministic tests. */
  nextId?: (prefix: string) => string;
}

const id =
  (seq: { n: number }) =>
  (prefix: string) =>
    `${prefix}_mock_${(++seq.n).toString(36)}${randomBytes(3).toString("hex")}`;

/**
 * Instant-success mock: checkout/portal return hosted-looking URLs, invoices
 * are created already "paid", and webhooks accept a plain JSON event shape
 * `{ "type": "subscription.activated", "customerId": ..., "subscriptionId": ... }`.
 */
export class MockPaymentsProvider implements PaymentsProvider {
  private readonly appUrl: string;
  private readonly nextId: (prefix: string) => string;
  /** Received webhook payloads, for assertions in tests. */
  readonly events: PaymentEvent[] = [];

  constructor(opts: MockPaymentsOptions = {}) {
    this.appUrl = opts.appUrl ?? "http://localhost:3000";
    this.nextId = opts.nextId ?? id({ n: 0 });
  }

  async createCheckoutSession(
    req: CheckoutSessionRequest,
  ): Promise<CheckoutSession> {
    const sid = this.nextId("cs");
    return {
      id: sid,
      url: `${this.appUrl}/billing/mock-checkout?session=${sid}&plan=${encodeURIComponent(req.plan)}`,
    };
  }

  async createPortalSession(opts: {
    customerId: string;
    returnUrl: string;
  }): Promise<PortalSession> {
    return {
      url: `${this.appUrl}/billing/mock-portal?customer=${encodeURIComponent(opts.customerId)}`,
    };
  }

  async createInvoice(req: InvoiceRequest): Promise<Invoice> {
    return {
      id: this.nextId("in"),
      hostedUrl: `${this.appUrl}/billing/mock-invoice/${this.nextId("inv")}`,
      amountMinor: req.amountMinor,
      currency: req.currency,
      status: "paid",
    };
  }

  async handleWebhook(
    payload: string | Uint8Array,
  ): Promise<PaymentEvent> {
    const raw =
      typeof payload === "string" ? payload : new TextDecoder().decode(payload);
    const body = JSON.parse(raw) as {
      type?: string;
      customerId?: string;
      subscriptionId?: string;
      metadata?: Record<string, string>;
    };
    const event: PaymentEvent =
      body.type === "subscription.activated" ||
      body.type === "subscription.canceled"
        ? {
            kind: body.type,
            customerId: body.customerId ?? "",
            subscriptionId: body.subscriptionId ?? "",
            metadata: body.metadata,
          }
        : { kind: "ignored", type: body.type ?? "unknown" };
    this.events.push(event);
    return event;
  }
}
