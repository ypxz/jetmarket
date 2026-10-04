import { clientIp, err, noStore, ok, rateLimit } from "@/lib/api";
import { currentUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";
import { publicOperator } from "@/lib/repo/types";
import { sweepStaleRfqs } from "@/lib/sweep";
import { isExpiredListing } from "@/lib/search";
import { rfqDeadlineAt } from "@/lib/rfq-deadline";
import { verticalConfig, verticalMessages } from "@/lib/vertical";
import { rfqFieldLabels, rfqFieldsFor } from "@jetmarket/verticals";

// Buyer-side view: quotes received for an RFQ. Gated by the per-RFQ bearer
// token issued in the post-submit redirect and the quote-notification email —
// possession of the link is proof of inbox (QA-39). New links carry it in the
// URL fragment (`#t=` — never server-logged, QA-240); the page forwards it as
// the x-rfq-token header. `?t=` stays accepted for links already emailed.
// QA-474: a signed-in buyer's session also proves the mailbox — it scopes
// the list to their own email (param ignored) so /quotes works without
// hunting for the emailed link. Bare email lookup stays unoffered.
export async function GET(req: Request) {
  if (!rateLimit(`buyer-quotes:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const url = new URL(req.url);
  const user = await currentUser();
  // Session covers only ITS OWN mailbox — a session user can still open
  // another mailbox's inbox with that mailbox's bearer token (assistant
  // booking for a principal). No session, no token → auth wall.
  const email = url.searchParams.get("email") ?? user?.email ?? null;
  const sessionOwns =
    !!user && user.email.toLowerCase() === email?.toLowerCase();
  // Prefer the header — bearer tokens in query strings persist in server
  // logs, browser history and Referer headers (QA-156). `t` stays accepted
  // for links issued before the header existed.
  const token =
    req.headers.get("x-rfq-token") ?? url.searchParams.get("t");
  if (!email) return err("email required", 400);
  if (!sessionOwns && !token) return err("use the link from your email", 401);
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
      // "Ending first" chip on /quotes — same deadline sort the operator
      // inbox has (QA-448).
      ...(url.searchParams.get("sort") === "deadline"
        ? { sort: "deadline" as const }
        : {}),
      limit: 200,
    })
    // Session-on-own-mailbox shows the whole inbox; every other case
    // (token path — session user's foreign link included) filters rows
    // to the ones that token opens.
  ).filter((r) => sessionOwns || r.accessToken === token);
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
  const opIds = [...new Set(quoteRows.map((q) => q.operatorId))];
  const [opByIdEntries, dealCounts] = await Promise.all([
    repo.listOperators({ ids: opIds }),
    // Track record beside every quote (QA-431): deals this operator closed
    // on THIS vertical — the trust signal a comparison page needs.
    repo.countDealsPerOperator(opIds, verticalSlug()),
  ]);
  const opById = new Map(
    opByIdEntries.map((o) => [o.id, publicOperator(o)] as const),
  );
  // QA-451: deal id + rating attach to ACCEPTED quotes — the buyer rates
  // the deal in place; ratingSummary feeds the operator trust line.
  const [dealByQuote, ratingSummary] = await Promise.all([
    repo.listDeals({ quoteIds: quoteRows.map((q) => q.id) }),
    repo.ratingSummaryPerOperator(opIds),
  ]);
  const dealByQuoteId = new Map(dealByQuote.map((d) => [d.quoteId, d]));
  // QA-449: post-close contact reveal — once a quote is ACCEPTED the deal
  // is closed and the buyer legitimately reaches the operator directly
  // (the close mail already carries this address; the page shouldn't make
  // them fish for it). Only the winning quote's operator resolves —
  // declined/withdrawn operators stay public-profile only.
  const contactByOp = new Map<string, string>();
  const opsByIdFull = new Map(opByIdEntries.map((o) => [o.id, o] as const));
  for (const q of quoteRows) {
    if (q.status !== "accepted" || contactByOp.has(q.operatorId)) continue;
    const op = opsByIdFull.get(q.operatorId);
    const owner = op ? await repo.getUser(op.userId) : undefined;
    if (owner) contactByOp.set(q.operatorId, owner.email);
  }
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
      // QA-442: when this request stops collecting offers — same derived
      // rule the worker sweep enforces (dated: after dateTo; else +30d).
      deadlineAt: rfqDeadlineAt(rfq).toISOString(),
      deliveredTo: deliveredCounts[rfq.id] ?? 0,
      requestFields: requestFieldsOf(rfq.listingId ?? "", rfq.fields),
      // QA-481: the field defs the live row's edit form renders — type +
      // label come from the vertical config server-side so the client
      // never imports it (same rule as requestFields).
      editFields: rfqFieldsFor(
        vertical,
        rfq.listingId ? listingById.get(rfq.listingId)?.type : undefined,
      ).map((f) => ({
        key: f.key,
        label: labels.get(f.key) ?? f.key,
        type: f.type,
        required: f.required,
        options: f.options?.map((o) => ({
          value: o.value,
          label: String(verticalMessages()[o.labelKey] ?? o.value),
        })),
      })),
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
          deal:
            q.status === "accepted"
              ? {
                  id: dealByQuoteId.get(q.id)?.id,
                  buyerRating: dealByQuoteId.get(q.id)?.buyerRating,
                }
              : undefined,
          operator: (() => {
            const o = opById.get(q.operatorId);
            return o
              ? {
                  // QA-490: links the offer card to /operators/<id> —
                  // the trust-check dead-end on the comparison page.
                  id: q.operatorId,
                  ...o,
                  dealsClosed: dealCounts[q.operatorId] ?? 0,
                  // QA-472: a suspended operator's offer can't be
                  // accepted — surface the state so the inbox doesn't
                  // offer a dead Accept button (post-reinstate it
                  // clears and the offer revives).
                  ...(opsByIdFull.get(q.operatorId)?.suspended
                    ? { unavailable: true }
                    : {}),
                  ratingAvg: ratingSummary[q.operatorId]?.avg,
                  ratingCount: ratingSummary[q.operatorId]?.count,
                  contactEmail:
                    q.status === "accepted"
                      ? contactByOp.get(q.operatorId)
                      : undefined,
                }
              : null;
          })(),
        })),
    })),
  ));
}
