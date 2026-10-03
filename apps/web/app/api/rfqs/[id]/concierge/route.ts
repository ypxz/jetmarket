import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { applyPaymentEvent } from "@/lib/billing";
import { CONCIERGE_PRICE_USD, site } from "@jetmarket/config";
import { toMinorUnits } from "@jetmarket/domain";
import { appOrigin } from "@/lib/origin";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";
import {
  paymentsProvider,
  paymentsProviderName,
} from "@jetmarket/providers";

const Concierge = z.object({
  buyerEmail: z.string().email().max(254),
  token: z.string().min(1).max(256),
});

/** Buyer concierge ($49/request): the bearer-token holder pays to expedite
 *  their request — every still-delayed fan-out match (free-plan operators)
 *  delivers immediately instead of after the delay window.
 *
 *  Real providers redirect to a hosted checkout (`checkoutUrl`) and the flag
 *  flips when `checkout.session.completed` lands on /api/billing/webhook.
 *  Mock mode has no hosted page — the route feeds the equivalent
 *  `payment.completed` event through the same normalize+apply path, so the
 *  upsell is instant in dev and e2e (same trick as billing/checkout). */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!rateLimit(`rfq-concierge:${clientIp(req)}`, 20, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, Concierge);
  if (error) return error;
  const { id } = await params;
  const repo = await getRepo();
  const rfq = await repo.getRfq(id);
  if (
    !rfq ||
    rfq.vertical !== verticalSlug() ||
    rfq.buyerEmail.toLowerCase() !== data!.buyerEmail.toLowerCase() ||
    rfq.accessToken !== data!.token
  ) {
    return err("not found", 404);
  }
  // Idempotent: a replayed webhook or a second click returns the flag as-is
  // rather than charging again (the CAS inside expediteRfq enforces it once).
  if (rfq.concierge) return ok({ concierge: true, checkoutUrl: null });
  if (!["open", "matched", "quoted"].includes(rfq.status)) {
    return err("rfq is no longer open", 409);
  }

  const origin = appOrigin(req);
  const email = encodeURIComponent(rfq.buyerEmail);
  const metadata = { kind: "concierge", rfqId: rfq.id };
  const session = await paymentsProvider().createPaymentSession({
    amountMinor: toMinorUnits(CONCIERGE_PRICE_USD, "USD"),
    currency: "USD",
    email: rfq.buyerEmail,
    description: `${site.name} concierge — expedite your request`,
    successUrl: `${origin}/quotes?email=${email}`,
    cancelUrl: `${origin}/rfq/thanks?id=${rfq.id}&email=${email}`,
    metadata,
  });

  if (paymentsProviderName() === "mock") {
    // Mock checkout auto-succeeds: emulate the provider's payment.completed
    // webhook in-process so the expedite applies now, not on a later poll.
    const event = await paymentsProvider().handleWebhook(
      JSON.stringify({
        type: "payment.completed",
        customerId: rfq.buyerEmail,
        metadata,
      }),
      null,
    );
    const applied = await applyPaymentEvent(repo, event);
    return ok({ concierge: applied, checkoutUrl: session.url });
  }
  return ok({ concierge: false, checkoutUrl: session.url });
}
