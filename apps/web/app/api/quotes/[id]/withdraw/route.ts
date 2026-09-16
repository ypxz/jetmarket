import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { analyticsProvider } from "@jetmarket/providers";

// Operator withdraws their own still-open quote.
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
  if (!quote) return err("quote not found", 404);
  if (quote.operatorId !== operator.id) return err("not your quote", 403);
  if (quote.status !== "sent") return err(`quote already ${quote.status}`, 409);

  await repo.setQuoteStatus(id, "withdrawn");
  analyticsProvider().track({
    name: "quote_withdrawn",
    props: { quoteId: quote.id, rfqId: quote.rfqId, operatorId: operator.id },
  });
  return ok(await repo.getQuote(id));
}
