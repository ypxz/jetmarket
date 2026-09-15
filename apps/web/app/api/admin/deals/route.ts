import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function GET() {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  const repo = getRepo();
  return ok(
    repo.listDeals().map((d) => ({
      ...d,
      quote: repo.getQuote(d.quoteId) ?? null,
      operator: repo.getOperator(d.operatorId) ?? null,
    })),
  );
}
