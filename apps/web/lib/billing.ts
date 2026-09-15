import type { PaymentEvent } from "@jetmarket/providers/payments";
import type { Plan, Repo } from "./repo/types";

/**
 * Apply a normalized provider payment event to the repo.
 * `subscription.activated` upgrades the operator + upserts the subscription
 * record; `subscription.canceled` downgrades to free and marks canceled.
 */
export async function applyPaymentEvent(
  repo: Repo,
  event: PaymentEvent,
): Promise<boolean> {
  if (event.kind === "ignored") return false;
  const operatorId = event.metadata?.operatorId ?? event.customerId;
  if (!operatorId) return false;

  if (event.kind === "subscription.activated") {
    const plan = (event.metadata?.plan ?? "pro") as Plan;
    await repo.upsertSubscription({
      operatorId,
      plan,
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 86400e3).toISOString(),
    });
    await repo.setOperatorPlan(operatorId, plan);
    return true;
  }
  // subscription.canceled
  const sub = await repo.getSubscription(operatorId);
  if (sub) {
    await repo.upsertSubscription({ ...sub, status: "canceled" });
  }
  await repo.setOperatorPlan(operatorId, "free");
  return true;
}
