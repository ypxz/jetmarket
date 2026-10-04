import { clientIp, err, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import type { Deal } from "@/lib/repo/types";
import { dealsToCsv } from "@/lib/deals-csv";

/** QA-489: the /app ledger paginates at 20 rows — an operator closing
 *  their books had no full pull. Exports every deal the session's
 *  operator closed, newest first. Operator-facing deal surfaces carry no
 *  vertical scope deliberately (a user's cross-vertical earnings are
 *  their business — same rule listDeals's admin-vs-operator split uses). */
export async function GET(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (
    !rateLimit(`operator-deals-export:${clientIp(req)}`, 30, 60 * 60 * 1000)
  ) {
    return err("rate limit exceeded — try again later", 429);
  }
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  // Page through rather than one unbounded select — an account can't pin
  // a worker on its own ledger.
  const deals: Deal[] = [];
  for (let offset = 0; offset < 10_000; offset += 200) {
    const page = await repo.listDeals({
      operatorId: operator.id,
      limit: 200,
      offset,
    });
    deals.push(...page);
    if (page.length < 200) break;
  }
  return new Response(dealsToCsv(deals), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="deals.csv"',
      "cache-control": "no-store",
    },
  });
}
