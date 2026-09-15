import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { paymentsProvider } from "@jetmarket/providers";

export async function POST(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  const { url } = await paymentsProvider().createPortalSession({
    customerId: operator.id,
    returnUrl: `${process.env.APP_URL ?? new URL(req.url).origin}/app/billing`,
  });
  return ok({ url });
}
