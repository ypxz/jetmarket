import { z } from "zod";
import { err, ok, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { applyPaymentEvent } from "@/lib/billing";
import { PRO_PLAN_PRICE_USD } from "@/lib/fees";
import { getRepo } from "@/lib/repo";
import {
  paymentsProvider,
  paymentsProviderName,
} from "@jetmarket/providers";

const Body = z.object({ plan: z.literal("pro") });

/**
 * Checkout via the payments provider. Mock + stripe-mock can't complete a
 * hosted page headlessly, so after session creation we feed the equivalent
 * `subscription.activated` event through the same `handleWebhook` → apply
 * path a real provider would hit (`POST /api/billing/webhook`).
 */
export async function POST(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("sign in as an operator first", 401);
  const { data, error } = await parseBody(req, Body);
  if (error) return error;

  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);

  const origin = process.env.APP_URL ?? new URL(req.url).origin;
  const session = await paymentsProvider().createCheckoutSession({
    operatorId: operator.id,
    plan: data!.plan,
    amountMinor: Math.round(PRO_PLAN_PRICE_USD * 100),
    currency: "USD",
    email: user.email,
    successUrl: `${origin}/app/billing?checkout=success`,
    cancelUrl: `${origin}/app/billing?checkout=cancel`,
    metadata: { operatorId: operator.id, plan: data!.plan },
  });

  if (paymentsProviderName() === "mock") {
    // Mock mode: the hosted page auto-succeeds, so emulate the provider's
    // subscription.activated webhook through the same normalize+apply path
    // that POST /api/billing/webhook uses. Keeps the e2e upgrade instant.
    const event = await paymentsProvider().handleWebhook(
      JSON.stringify({
        type: "subscription.activated",
        customerId: operator.id,
        subscriptionId: session.id,
        metadata: { operatorId: operator.id, plan: data!.plan },
      }),
      null,
    );
    await applyPaymentEvent(repo, event);
    return ok({ subscribed: true, plan: data!.plan, checkoutUrl: session.url });
  }

  // Real provider: client redirects to the hosted checkout; activation
  // arrives via the webhook route when the subscription is created.
  return ok({ subscribed: false, plan: data!.plan, checkoutUrl: session.url });
}
