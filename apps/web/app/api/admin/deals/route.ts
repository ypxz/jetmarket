import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function GET(req: Request) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (!rateLimit(`admin-deals:${clientIp(req)}`, 600, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const repo = await getRepo();
  // Optional ?limit/&offset= cap the payload; default is one page (QA-67).
  const url = new URL(req.url);
  const lim = Number(url.searchParams.get("limit"));
  const off = Number(url.searchParams.get("offset"));
  const dealRows = await repo.listDeals({
    limit: Number.isInteger(lim) && lim >= 1 ? Math.min(lim, 200) : 50,
    offset: Number.isInteger(off) && off >= 0 ? off : 0,
  });
  // Two batched lookups instead of 2N per-row fetches (QA-103).
  const [quoteRows, opRows] = await Promise.all([
    repo.listQuotes({ ids: [...new Set(dealRows.map((d) => d.quoteId))] }),
    repo.listOperators({ ids: [...new Set(dealRows.map((d) => d.operatorId))] }),
  ]);
  const quoteById = new Map(quoteRows.map((q) => [q.id, q] as const));
  const opById = new Map(opRows.map((o) => [o.id, o] as const));
  return ok(
    dealRows.map((d) => ({
      ...d,
      quote: quoteById.get(d.quoteId) ?? null,
      operator: opById.get(d.operatorId) ?? null,
    })),
  );
}
