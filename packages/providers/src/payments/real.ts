import Stripe from "stripe";
import type {
  CheckoutSession,
  CheckoutSessionRequest,
  Invoice,
  InvoiceRequest,
  PaymentEvent,
  PaymentsProvider,
  PortalSession,
} from "./types";

export interface StripePaymentsOptions {
  secretKey: string; // STRIPE_SECRET_KEY
  /** Override API base — STRIPE_API_BASE=http://localhost:12111 for stripe-mock. */
  apiBase?: string;
  webhookSecret?: string; // STRIPE_WEBHOOK_SECRET
  /** Plan price ids from the Stripe catalog, keyed by plan slug. */
  priceIds?: Record<string, string>;
}

function apiBaseConfig(apiBase?: string): Pick<
  Stripe.StripeConfig,
  "host" | "port" | "protocol"
> {
  if (!apiBase) return {};
  const u = new URL(apiBase);
  return {
    host: u.hostname,
    port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
    protocol: u.protocol.replace(":", "") as "http" | "https",
  };
}

/**
 * Stripe payments (checkout subscriptions, billing portal, success-fee
 * invoices, webhook → normalized subscription events). Runs against
 * stripe-mock via STRIPE_API_BASE for contract tests.
 */
export class StripePaymentsProvider implements PaymentsProvider {
  private readonly stripe: Stripe;
  private readonly webhookSecret?: string;
  private readonly priceIds: Record<string, string>;

  constructor(opts: StripePaymentsOptions) {
    this.stripe = new Stripe(opts.secretKey || "sk_test_mock", {
      apiVersion: "2026-08-26.dahlia",
      ...apiBaseConfig(opts.apiBase),
    });
    this.webhookSecret = opts.webhookSecret;
    this.priceIds = opts.priceIds ?? {};
  }

  async createCheckoutSession(
    req: CheckoutSessionRequest,
  ): Promise<CheckoutSession> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: req.email,
      line_items: [
        this.priceIds[req.plan]
          ? { price: this.priceIds[req.plan], quantity: 1 }
          : {
              quantity: 1,
              price_data: {
                currency: (req.currency ?? "usd").toLowerCase(),
                unit_amount: req.amountMinor ?? 0,
                recurring: { interval: "month" },
                product_data: { name: `JetMarket ${req.plan} plan` },
              },
            },
      ],
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      metadata: { operatorId: req.operatorId, plan: req.plan, ...req.metadata },
      subscription_data: {
        metadata: { operatorId: req.operatorId, plan: req.plan },
      },
    });
    return { id: session.id, url: session.url ?? "" };
  }

  async createPortalSession(opts: {
    customerId: string;
    returnUrl: string;
  }): Promise<PortalSession> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: opts.customerId,
      return_url: opts.returnUrl,
    });
    return { url: session.url };
  }

  async createInvoice(req: InvoiceRequest): Promise<Invoice> {
    const item = await this.stripe.invoiceItems.create(
      {
        customer: req.customerId,
        amount: req.amountMinor,
        currency: req.currency.toLowerCase(),
        description: req.description,
      },
      req.idempotencyKey ? { idempotencyKey: req.idempotencyKey } : undefined,
    );
    const invoice = await this.stripe.invoices.create(
      {
        customer: req.customerId,
        collection_method: "send_invoice",
        days_until_due: 30,
        auto_advance: true,
        metadata: req.metadata ?? {},
      },
      req.idempotencyKey ? { idempotencyKey: `${req.idempotencyKey}-inv` } : undefined,
    );
    return {
      id: invoice.id,
      hostedUrl: invoice.hosted_invoice_url ?? undefined,
      amountMinor: item.amount,
      currency: item.currency,
      status: invoice.status ?? "draft",
    };
  }

  async handleWebhook(
    payload: string | Uint8Array,
    signature: string | null,
  ): Promise<PaymentEvent> {
    if (!this.webhookSecret || !signature) {
      throw new Error(
        "stripe webhook requires STRIPE_WEBHOOK_SECRET + stripe-signature header",
      );
    }
    const body =
      typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
    const event = this.stripe.webhooks.constructEvent(
      body,
      signature,
      this.webhookSecret,
    );
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        if (sub.status !== "active" && sub.status !== "trialing") {
          return { kind: "ignored", type: `${event.type}:${sub.status}` };
        }
        return {
          kind: "subscription.activated",
          customerId: String(sub.customer),
          subscriptionId: sub.id,
          metadata: sub.metadata,
        };
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        return {
          kind: "subscription.canceled",
          customerId: String(sub.customer),
          subscriptionId: sub.id,
          metadata: sub.metadata,
        };
      }
      default:
        return { kind: "ignored", type: event.type };
    }
  }
}
