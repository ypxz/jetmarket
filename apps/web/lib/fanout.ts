import { deliverAt, matchOperators } from "@jetmarket/domain";
import { rfqFieldLabels } from "@jetmarket/verticals";
import { site } from "@jetmarket/config";
import { verticalConfig, verticalMessages } from "@/lib/vertical";
import type { OperatorCandidate } from "@jetmarket/domain";
import { brandedEmailHtml, emailProvider } from "@jetmarket/providers";
import { logWarn } from "@/lib/log";
import type { Listing, Repo, Rfq } from "@/lib/repo/types";

/**
 * Memory-mode RFQ fan-out — the worker only exists in pg mode, so mock demos
 * would otherwise notify nobody but the listing owner. Runs the same domain
 * matching inline; delayed matches carry `deliverAt` and surface once due
 * (the memory repo checks lazily on read — no sweep needed).
 */
export async function fanoutRfq(repo: Repo, rfq: Rfq, listing: Listing) {
  const vertical = verticalConfig();
  const matching = vertical.matching;
  // Fleet attribute keys come from the vertical's matching config — machinery
  // fleets are `machineryCategory`, not `aircraftCategory` (QA-229).
  const catAttr = matching?.categoryAttribute ?? "aircraftCategory";
  const seatAttr = matching ? matching.seatsAttribute : "seats";
  const ops = await repo.listOperators();
  // Same shared-DB rule as the worker's loadOperatorCandidates (QA-307):
  // an operator whose whole book is foreign-vertical is a dealer there,
  // not a broker here — zero-listing operators keep the wildcard.
  const inScope = new Set<string>();
  for (const o of ops) {
    const anyListing = await repo.listListings({
      operatorId: o.id,
      limit: 1,
    });
    const sameVertical = await repo.listListings({
      operatorId: o.id,
      vertical: vertical.slug,
      limit: 1,
    });
    if (anyListing.length === 0 || sameVertical.length > 0) inScope.add(o.id);
  }
  const candidates: OperatorCandidate[] = await Promise.all(
    ops
      .filter((o) => inScope.has(o.id))
      .map(async (o) => ({
      id: o.id,
      verified: o.verified,
      planId: o.plan,
      baseAirport: o.baseAirport,
      // Fleet mirrors the worker's loadOperatorCandidates.
      fleet: (
        await repo.listListings({
          operatorId: o.id,
          status: "active",
          vertical: vertical.slug,
          ...(matching?.fleetListingType
            ? { type: matching.fleetListingType }
            : {}),
        })
      ).map((l) => {
        const a = l.attributes;
        return {
          listingId: l.id,
          category:
            typeof a[catAttr] === "string" ? a[catAttr] : undefined,
          seats:
            seatAttr !== undefined && typeof a[seatAttr] === "number"
              ? a[seatAttr]
              : undefined,
        };
      }),
    })),
  );
  // The RFQ form may not ask for a category (jets and machinery both omit
  // it) — an RFQ on a lathe listing wants lathe dealers. Infer it from the
  // listing's own category attribute; an explicit RFQ field wins (QA-229).
  const reqFields = { ...rfq.fields };
  if (
    catAttr &&
    reqFields[catAttr] === undefined &&
    typeof listing.attributes[catAttr] === "string"
  ) {
    reqFields[catAttr] = listing.attributes[catAttr];
  }
  // Plans come from the active vertical, not the domain's default mirror —
  // a machinery-priced delay must not silently run jets' 24h (QA-221).
  const matches = matchOperators(
    reqFields,
    candidates,
    vertical.fees.subscriptionPlans,
    {
      limit: 10,
      excludeOperatorIds: new Set([listing.operatorId]),
      ...(matching?.rfqCategoryKeys
        ? { categoryKeys: matching.rfqCategoryKeys }
        : {}),
      ...(matching?.rfqSeatsKeys ? { seatsKeys: matching.rfqSeatsKeys } : {}),
    },
  );
  if (!matches.length) return;

  const at = new Date();
  await repo.createRfqMatches(
    matches.map((m) => ({
      rfqId: rfq.id,
      operatorId: m.operatorId,
      listingId: m.listingId,
      ...(m.delivery === "delayed" ? { deliverAt: deliverAt(m, at) } : {}),
    })),
  );

  // Instant matches get the same notification email the worker sends in pg
  // mode; delayed matches stay silent until due (mock outbox has no sweep).
  const f = rfq.fields;
  const opsById = new Map(ops.map((o) => [o.id, o]));
  // Buyer contact stays masked until a deal closes (QA-152) — name only,
  // same masking the worker's quote_notification applies in pg mode.
  const buyerName =
    typeof f["name"] === "string" && f["name"].trim() ? f["name"] : "A buyer";
  // Field detail lines mirror the worker's email (QA-234): the vertical's
  // declared fields, labeled and in form order, plus undeclared extras.
  const labels = rfqFieldLabels(vertical, verticalMessages());
  const CONTACT_KEYS = new Set(["name", "email", "phone"]);
  const declaredOrder = [...labels.keys()];
  const detailKeys = [
    ...declaredOrder.filter((k) => !CONTACT_KEYS.has(k)),
    ...Object.keys(f).filter(
      (k) => !CONTACT_KEYS.has(k) && !declaredOrder.includes(k),
    ),
  ];
  const detailLines = detailKeys
    .filter((k) => f[k] !== undefined && f[k] !== null && String(f[k]) !== "")
    .map((k) => `${labels.get(k) ?? k}: ${String(f[k])}`);
  const route = [f["departure"] ?? f["from"], f["arrival"] ?? f["to"]]
    .filter(Boolean)
    .join(" → ");
  const subject = ["New RFQ", route, listing.title].filter(Boolean).join(" — ");
  for (const m of matches) {
    if (m.delivery === "delayed") continue;
    const op = opsById.get(m.operatorId);
    const user = op ? await repo.getUser(op.userId) : undefined;
    if (!user) continue;
    try {
      await emailProvider().send({
        to: user.email,
        subject,
        text:
          `You have a new request for quotation on ${site.name}.\n\n` +
          `${detailLines.join("\n")}\n` +
          `Buyer: ${buyerName}\n\n` +
          `Open your operator inbox to send a quote.`,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [
            `You have a new request for quotation on ${site.name}.`,
            ...detailLines,
            `Buyer: ${buyerName}`,
            "Open your operator inbox to send a quote.",
          ],
        }),
      });
    } catch (e) {
      logWarn("rfq.fanout_email_failed", {
        rfqId: rfq.id,
        operatorId: m.operatorId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
