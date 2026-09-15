import { z } from "zod";
import { err, ok, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

const Body = z.object({ plan: z.literal("pro") });

// Mock checkout: instant success → subscription + plan upgrade. Real impl =
// Stripe checkout session vs stripe-mock (packages/providers/payments).
export async function POST(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("sign in as an operator first", 401);
  const { error } = await parseBody(req, Body);
  if (error) return error;

  const repo = getRepo();
  const operator = repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);

  repo.upsertSubscription({
    operatorId: operator.id,
    plan: "pro",
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 86400e3).toISOString(),
  });
  repo.setOperatorPlan(operator.id, "pro");
  return ok({ subscribed: true, plan: "pro" });
}
