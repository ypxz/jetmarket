import { clientIp, err, noStore, ok, rateLimit } from "@/lib/api";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";
import { publicOperator } from "@/lib/repo/types";
import { sweepStaleRfqs } from "@/lib/sweep";
import { isExpiredListing } from "@/lib/search";
import { verticalConfig, verticalMessages } from "@/lib/vertical";
import { rfqFieldLabels, rfqFieldsFor } from "@jetmarket/verticals";

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
  const rfqs = (
    await repo.listRfqs({
      buyerEmail: email,
      // Per-vertical inbox: foreign-vertical RFQ tokens never resolve
      // here — that deploy's own origin serves them (QA-297).
      vertical: verticalSlug(),
      limit: 200,
    })
  ).filter((r) => r.accessToken === token);
  // Batched: one listing + one quote + one operator lookup for the whole
  // inbox — was ~3 queries per quote row (QA-103). Buyers legitimately see
  // every quote on their own RFQs.
  const rfqIds = rfqs.map((r) => r.id);
  const [listingRows, quoteRows, deliveredCounts] = await Promise.all([
    repo.listListings({
      ids: [
        ...new Set(
          rfqs
            .map((r) => r.listingId)
            .filter((x): x is string => x !== null),
        ),
      ],
    }),
    repo.listQuotes({ rfqIds }),
    // "In N operator inboxes" — the buyer's proof their request went out,
    // and the concierge purchase's receipt on the page (QA-401).
    repo.countDeliveredMatches(rfqIds),
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
  // Echo the buyer's own request fields (QA-241): "Departure: TEB · …" so the
  // inbox shows what was asked, not just the listing + quote prices. Contact
  // fields are skipped — the buyer already has them. Ordered by vertical
  // field defs so it reads like the form they submitted.
  const vertical = verticalConfig();
  const labels = rfqFieldLabels(vertical, verticalMessages());
  const contactTypes = new Set(["email", "tel"]);
  const requestFieldsOf = (
    listingId: string,
    fields: Record<string, unknown>,
  ) => {
    const type = listingById.get(listingId)?.type;
    return rfqFieldsFor(vertical, type)
      .filter((f) => !contactTypes.has(f.type))
      .flatMap((f) => {
        const v = fields[f.key];
        return v === undefined || v === null || v === ""
          ? []
          : [{ label: labels.get(f.key) ?? f.key, value: String(v) }];
      });
  };
  return noStore(ok(
    rfqs.map((rfq) => ({
      // strip the bearer token — callers proved inbox access to get here,
      // but there's no reason to echo it back
      ...{ ...rfq, accessToken: undefined },
      deliveredTo: deliveredCounts[rfq.id] ?? 0,
      requestFields: requestFieldsOf(rfq.listingId ?? "", rfq.fields),
      listing: (() => {
        const l = rfq.listingId
          ? (listingById.get(rfq.listingId) ?? null)
          : null;
        // Browseable = still publicly renderable; expired/withdrawn listings
        // 404 on /listing/[id] and must not be linked from the inbox (QA-244).
        return l
          ? { ...l, browseable: l.status === "active" && !isExpiredListing(l) }
          : null;
      })(),
      quotes: (quotesByRfq.get(rfq.id) ?? [])
        // QA-414: the buyer compares offers — cheapest first makes the
        // comparison the page's default, not its homework. createdAt
        // tiebreak keeps equal-price rows stable.
        .sort(
          (a, b) => a.amount - b.amount || a.createdAt.localeCompare(b.createdAt),
        )
        .map((q) => ({
          ...q,
          operator: opById.get(q.operatorId) ?? null,
        })),
    })),
  ));
}
