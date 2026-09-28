import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { getRepo } from "@/lib/repo";
import { publicOperator } from "@/lib/repo/types";
import { sweepStaleRfqs } from "@/lib/sweep";

// Buyer-side view: quotes received for an RFQ. Gated by the per-RFQ bearer
// token issued in the post-submit redirect and the quote-notification email —
// possession of the link is proof of inbox (QA-39). New links carry it in the
// URL fragment (`#t=` — never server-logged, QA-240); the page forwards it as
// the x-rfq-token header. `?t=` stays accepted for links already emailed.
// Bare email lookup is deliberately not offered.
export async function GET(req: Request) {
  if (!rateLimit(`buyer-quotes:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const url = new URL(req.url);
  const email = url.searchParams.get("email");
  // Prefer the header — bearer tokens in query strings persist in server
  // logs, browser history and Referer headers (QA-156). `t` stays accepted
  // for links issued before the header existed.
  const token =
    req.headers.get("x-rfq-token") ?? url.searchParams.get("t");
  if (!email) return err("email required", 400);
  if (!token) return err("use the link from your email", 401);
  const repo = await getRepo();
  // Memory mode has no worker — expire stale RFQs lazily so the buyer inbox
  // shows closed state instead of dead RFQs forever (QA-142).
  await sweepStaleRfqs(repo);
  // The token match happens post-fetch, so the cap must stay generous — a
  // buyer with >200 RFQs on older links loses the match. Still bounded.
  const rfqs = (await repo.listRfqs({ buyerEmail: email, limit: 200 })).filter(
    (r) => r.accessToken === token,
  );
  // Batched: one listing + one quote + one operator lookup for the whole
  // inbox — was ~3 queries per quote row (QA-103). Buyers legitimately see
  // every quote on their own RFQs.
  const [listingRows, quoteRows] = await Promise.all([
    repo.listListings({ ids: [...new Set(rfqs.map((r) => r.listingId))] }),
    repo.listQuotes({ rfqIds: rfqs.map((r) => r.id) }),
  ]);
  const opById = new Map(
    (
      await repo.listOperators({
        ids: [...new Set(quoteRows.map((q) => q.operatorId))],
      })
    ).map((o) => [o.id, publicOperator(o)] as const),
  );
  const listingById = new Map(listingRows.map((l) => [l.id, l] as const));
  const quotesByRfq = new Map<string, typeof quoteRows>();
  for (const q of quoteRows) {
    const arr = quotesByRfq.get(q.rfqId) ?? [];
    arr.push(q);
    quotesByRfq.set(q.rfqId, arr);
  }
  return ok(
    rfqs.map((rfq) => ({
      // strip the bearer token — callers proved inbox access to get here,
      // but there's no reason to echo it back
      ...{ ...rfq, accessToken: undefined },
      listing: listingById.get(rfq.listingId) ?? null,
      quotes: (quotesByRfq.get(rfq.id) ?? []).map((q) => ({
        ...q,
        operator: opById.get(q.operatorId) ?? null,
      })),
    })),
  );
}
