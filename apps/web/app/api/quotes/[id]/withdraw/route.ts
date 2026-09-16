import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

// TODO(T27): minimal operator withdraw route — full lifecycle lands with W2.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);

  const { id } = await params;
  const quote = await repo.getQuote(id);
  if (!quote || quote.operatorId !== operator.id) {
    return err("quote not found", 404);
  }
  if (quote.status !== "sent") return err(`quote already ${quote.status}`, 409);

  await repo.setQuoteStatus(id, "withdrawn");
  return ok({ quote: await repo.getQuote(id) });
}
