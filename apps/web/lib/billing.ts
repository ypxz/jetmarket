import { analyticsProvider } from "@jetmarket/providers";
import type { PaymentEvent } from "@jetmarket/providers/payments";
import { applyConciergePaid } from "./concierge";
import type { Plan, Repo } from "./repo/types";

/**
 * Apply a normalized provider payment event to the repo.
 * `subscription.activated` upgrades the operator + upserts the subscription
 * record; `subscription.canceled` downgrades to free and marks canceled.
 * `payment.completed` is a one-off buyer charge — kind=concierge expedites
 * the RFQ it paid for; anything else is acknowledged-but-unactioned.
 */
export async function applyPaymentEvent(
  repo: Repo,
  event: PaymentEvent,
): Promise<boolean> {
  if (event.kind === "ignored") return false;
  if (event.kind === "payment.completed") {
    if (event.metadata?.kind !== "concierge") return false;
    const rfqId = event.metadata?.rfqId;
    if (!rfqId) return false;
    const applied = await applyConciergePaid(repo, rfqId);
    if (applied) {
      // Revenue event — the funnel's only paid-buyer signal (plan events
      // cover operators). Idempotent: a replayed event CASes to applied=false
      // and never double-counts.
      analyticsProvider().track({
        name: "concierge_purchased",
        props: { rfqId, amountUsd: 49 },
      });
    }
    return applied;
  }
  const operatorId = event.metadata?.operatorId ?? event.customerId;
  if (!operatorId) return false;

  // Stale provider event (out-of-order webhook): skip the whole update, not
  // just the sub row — otherwise a late "canceled" would still downgrade the
  // operator plan while the newer subscription row stays active.
  const prev = await repo.getSubscription(operatorId);
  if (
    event.created != null &&
    prev?.lastEventAt != null &&
    event.created <= prev.lastEventAt
  ) {
    return false;
  }

  if (event.kind === "subscription.activated") {
    const plan = (event.metadata?.plan ?? "pro") as Plan;
    await repo.upsertSubscription({
      operatorId,
      plan,
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 86400e3).toISOString(),
      lastEventAt: event.created,
    });
    await repo.setOperatorPlan(operatorId, plan);
    analyticsProvider().track({
      name: "plan_upgraded",
      props: { operatorId, plan },
    });
    return true;
  }
  // subscription.canceled
  const sub = await repo.getSubscription(operatorId);
  if (sub) {
    await repo.upsertSubscription({
      ...sub,
      status: "canceled",
      // unstamped (undefined) always applies; a stale stamped cancel is
      // dropped by the repo's last-event gate
      lastEventAt: event.created,
    });
  }
  await repo.setOperatorPlan(operatorId, "free");
  analyticsProvider().track({
    name: "plan_downgraded",
    props: { operatorId },
  });
  return true;
}
