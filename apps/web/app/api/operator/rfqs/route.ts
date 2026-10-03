import { clientIp, err, noStore, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { SEARCH_PAGE_SIZE } from "@/lib/search";
import { sweepStaleRfqs } from "@/lib/sweep";
import { operatorRfqView } from "@/lib/rfq-view";
import { verticalConfig, verticalSlug } from "@/lib/vertical";

export async function GET(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`operator-rfqs:${clientIp(req)}`, 600, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  // Memory mode has no worker — lazy expiry keeps dead RFQs out of the
  // operator inbox (QA-142).
  await sweepStaleRfqs(repo);
  // Optional paging — ?limit=&offset= cap the payload; default is one page.
  const url = new URL(req.url);
  const lim = Number(url.searchParams.get("limit"));
  const off = Number(url.searchParams.get("offset"));
  const rfqs = await repo.listRfqs({
    operatorId: operator.id,
    // ?needs=1 — only RFQs without a live quote from this operator (QA-402).
    needsQuote: url.searchParams.get("needs") === "1" || undefined,
    // Shared-DB deployments host >1 vertical: machinery RFQs masked with
    // jets field defs would leak buyer contacts (QA-294).
    vertical: verticalSlug(),
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
  // Contact fields (email/tel) + buyerEmail are hidden until the buyer
  // accepts — the marketplace intro is its fee; raw contact details pre-deal
  // invite off-platform deals that bypass it (QA-152).
  const vertical = verticalConfig();
  return noStore(ok(
    rfqs.map((rfq) => {
      const listing = listingById.get(rfq.listingId) ?? null;
      return {
        ...operatorRfqView(rfq, listing?.type, vertical),
        listing,
        // own quotes only — matched operators must not see competitors' amounts (QA-73)
        quotes: quotesByRfq.get(rfq.id) ?? [],
      };
    }),
  ));
}
