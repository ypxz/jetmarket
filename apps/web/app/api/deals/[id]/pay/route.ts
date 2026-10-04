import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { applyPaymentEvent } from "@/lib/billing";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import {
  paymentsProvider,
  paymentsProviderName,
} from "@jetmarket/providers";

/**
 * "Pay fee" on the operator's deal wall (QA-450).
 *
 * Mock mode: the hosted invoice page auto-succeeds — emulate the provider's
 * `invoice.paid` → `payment.completed{kind:"dealFee"}` webhook through the
 * same apply path a real settle would take, so the button flips the badge
 * instantly (mirrors the billing-checkout mock pattern).
 *
 * Real provider: hand back the stored hosted invoice URL for the client to
 * open; the settle arrives as a stripe `invoice.paid` webhook.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("operator");
  if (!user) return err("sign in as an operator first", 401);
  if (!rateLimit(`deal-pay:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);

  const { id } = await params;
  const deal = await repo.getDeal(id);
  // Deals settle between the marketplace and the operator — the buyer never
  // sees this surface, and another operator gets the same 404.
  if (!deal || deal.operatorId !== operator.id) return err("not found", 404);
  if (deal.invoiceStatus === "paid") return ok({ paid: true });
  if (deal.invoiceStatus !== "invoiced" && deal.invoiceStatus !== "pending") {
    return err("this invoice is void", 409);
  }
  if (!deal.invoiceUrl) {
    return err("no payment link on this invoice yet", 409);
  }

  if (paymentsProviderName() === "mock") {
    // payment.completed{kind:dealFee} is the NORMALIZED form of the real
    // provider's invoice.paid webhook — feed it through the same apply path.
    const event = await paymentsProvider().handleWebhook(
      JSON.stringify({
        type: "payment.completed",
        customerId: operator.id,
        metadata: { kind: "dealFee", dealId: deal.id },
      }),
      null,
    );
    const paid = await applyPaymentEvent(repo, event);
    return ok({ paid, invoiceUrl: deal.invoiceUrl });
  }
  return ok({ paid: false, invoiceUrl: deal.invoiceUrl });
}
