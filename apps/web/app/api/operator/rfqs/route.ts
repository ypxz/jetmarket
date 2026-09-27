import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { SEARCH_PAGE_SIZE } from "@/lib/search";

export async function GET(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  // Optional paging — ?limit=&offset= cap the payload; default is one page.
  const url = new URL(req.url);
  const lim = Number(url.searchParams.get("limit"));
  const off = Number(url.searchParams.get("offset"));
  const rfqs = await repo.listRfqs({
    operatorId: operator.id,
    limit: Number.isInteger(lim) && lim >= 1 ? Math.min(lim, 100) : SEARCH_PAGE_SIZE,
    offset: Number.isInteger(off) && off >= 0 ? off : 0,
  });
  return ok(
    await Promise.all(
      rfqs.map(async (rfq) => ({
        // never leak the buyer bearer token — operators with it could
        // impersonate the buyer and accept their own quote (QA-41)
        ...{ ...rfq, accessToken: undefined },
        listing: (await repo.getListing(rfq.listingId)) ?? null,
        quotes: await repo.listQuotes({ rfqId: rfq.id }),
      })),
    ),
  );
}
