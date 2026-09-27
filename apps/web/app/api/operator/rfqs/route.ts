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
  // Batched: one listing + one own-quotes lookup for the whole page — was
  // 2 queries per RFQ row (QA-103).
  const [listingRows, quoteRows] = await Promise.all([
    repo.listListings({ ids: [...new Set(rfqs.map((r) => r.listingId))] }),
    repo.listQuotes({ rfqIds: rfqs.map((r) => r.id), operatorId: operator.id }),
  ]);
  const listingById = new Map(listingRows.map((l) => [l.id, l] as const));
  const quotesByRfq = new Map<string, typeof quoteRows>();
  for (const q of quoteRows) {
    const arr = quotesByRfq.get(q.rfqId) ?? [];
    arr.push(q);
    quotesByRfq.set(q.rfqId, arr);
  }
  return ok(
    rfqs.map((rfq) => ({
      // never leak the buyer bearer token — operators with it could
      // impersonate the buyer and accept their own quote (QA-41)
      ...{ ...rfq, accessToken: undefined },
      listing: listingById.get(rfq.listingId) ?? null,
      // own quotes only — matched operators must not see competitors' amounts (QA-73)
      quotes: quotesByRfq.get(rfq.id) ?? [],
    })),
  );
}
