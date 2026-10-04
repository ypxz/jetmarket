import { z } from "zod";
import { toMinorUnits } from "@jetmarket/domain";
import { localePath } from "@jetmarket/i18n";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { applyPaymentEvent } from "@/lib/billing";
import { PRO_PLAN_PRICE_USD } from "@/lib/fees";
import { plans } from "@jetmarket/config";
import { getRepo } from "@/lib/repo";
import {
  paymentsProvider,
  paymentsProviderName,
} from "@jetmarket/providers";
import { appOrigin } from "@/lib/origin";

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
  if (!rateLimit(`billing-checkout:${clientIp(req)}`, 10, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, Body);
  if (error) return error;

  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);

  const origin = appOrigin(req);
  const session = await paymentsProvider().createCheckoutSession({
    operatorId: operator.id,
    plan: data!.plan,
    amountMinor: toMinorUnits(PRO_PLAN_PRICE_USD, plans.pro.currency),
    // Plan-declared currency (plans.pro.currency) — not the vertical's
    // listing currency: a EUR marketplace can still price Pro in USD.
    currency: plans.pro.currency,
    email: user.email,
    // QA-496: return path keeps the operator's sign-in locale.
    successUrl: `${origin}${localePath(user.locale, "/app/billing?checkout=success")}`,
    cancelUrl: `${origin}${localePath(user.locale, "/app/billing?checkout=cancel")}`,
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
