import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function POST() {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  const repo = getRepo();
  const operator = repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  return ok({
    url: `/app/billing/portal-mock?operator=${operator.id}`,
    note: "mock portal — real impl redirects to Stripe customer portal",
  });
}
