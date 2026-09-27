import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function GET(req: Request) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  const repo = await getRepo();
  // Optional ?limit/&offset= cap the payload; default is one page (QA-67).
  const url = new URL(req.url);
  const lim = Number(url.searchParams.get("limit"));
  const off = Number(url.searchParams.get("offset"));
  const dealRows = await repo.listDeals({
    limit: Number.isInteger(lim) && lim >= 1 ? Math.min(lim, 200) : 50,
    offset: Number.isInteger(off) && off >= 0 ? off : 0,
  });
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
