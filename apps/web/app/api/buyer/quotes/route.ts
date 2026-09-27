import { err, ok } from "@/lib/api";
import { getRepo } from "@/lib/repo";

// Buyer-side view: quotes received for an RFQ. Gated by the per-RFQ bearer
// token (`t`) issued in the post-submit redirect and the quote-notification
// email — possession of the link is proof of inbox (QA-39). Bare email lookup
// is deliberately not offered.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const email = url.searchParams.get("email");
  const token = url.searchParams.get("t");
  if (!email) return err("email required", 400);
  if (!token) return err("use the link from your email", 401);
  const repo = await getRepo();
  const rfqs = (await repo.listRfqs({ buyerEmail: email })).filter(
    (r) => r.accessToken === token,
  );
  return ok(
    await Promise.all(
      rfqs.map(async (rfq) => ({
        // strip the bearer token — callers proved inbox access to get here,
        // but there's no reason to echo it back
        ...{ ...rfq, accessToken: undefined },
        listing: (await repo.getListing(rfq.listingId)) ?? null,
        quotes: await Promise.all(
          (await repo.listQuotes({ rfqId: rfq.id })).map(async (q) => ({
            ...q,
            operator: (await repo.getOperator(q.operatorId)) ?? null,
          })),
        ),
      })),
    ),
  );
}
