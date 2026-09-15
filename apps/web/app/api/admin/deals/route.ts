import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function GET() {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  const repo = await getRepo();
  const dealRows = await repo.listDeals();
  return ok(
    await Promise.all(
      dealRows.map(async (d) => ({
        ...d,
        quote: (await repo.getQuote(d.quoteId)) ?? null,
        operator: (await repo.getOperator(d.operatorId)) ?? null,
      })),
    ),
  );
}
