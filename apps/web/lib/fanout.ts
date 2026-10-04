import { deliverAt, matchOperators } from "@jetmarket/domain";
import { rfqFieldLabels } from "@jetmarket/verticals";
import { site } from "@jetmarket/config";
import { verticalConfig, verticalMessages } from "@/lib/vertical";
import type { OperatorCandidate } from "@jetmarket/domain";
import { brandedEmailHtml, emailProvider } from "@jetmarket/providers";
import { logWarn } from "@/lib/log";
import type { Listing, Operator, Repo, Rfq } from "@/lib/repo/types";

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
      // QA-427: away operators sit out new fan-outs (the worker's
      // loadOperatorCandidates encodes the same rule on the pg path).
      // QA-460: suspended operators sit out too — enforcement, not away.
      .filter((o) => inScope.has(o.id) && o.acceptingRfqs && !o.suspended)
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
  const opsById = new Map(ops.map((o) => [o.id, o]));
  await emailRfqMatches(
    repo,
    rfq,
    listing.title,
    matches.filter((m) => m.delivery !== "delayed").map((m) => m.operatorId),
    opsById,
  );
}

/**
 * The "new RFQ" operator email — identical to the worker's
 * `email.quote_notification` build in pg mode (QA-234 field lines, QA-152
 * name-only masking). `opsById` lets the caller reuse already-loaded
 * operator rows; missing entries are fetched one at a time.
 */
/** Shared mail details for RFQ operator notices: masked buyer name, the
 *  vertical's declared field lines (QA-234) plus undeclared extras, and
 *  the route string the subject carries. */
function rfqMailDetails(f: Record<string, unknown>) {
  const vertical = verticalConfig();
  // Buyer contact stays masked until a deal closes (QA-152) — name only.
  const buyerName =
    typeof f["name"] === "string" && f["name"].trim() ? f["name"] : "A buyer";
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
  return { buyerName, detailLines, route };
}

export async function emailRfqMatches(
  repo: Repo,
  rfq: Rfq,
  listingTitle: string | undefined,
  operatorIds: string[],
  opsById?: Map<string, Operator>,
) {
  const f = rfq.fields;
  const { buyerName, detailLines, route } = rfqMailDetails(f);
  const subject = ["New RFQ", route, listingTitle].filter(Boolean).join(" — ");
  // Concierge RFQs are paid expedites — flag them so operators quote first
  // (same line the worker's email.quote_notification adds in pg mode).
  const priorityLine = rfq.concierge
    ? "Priority request — the buyer paid for immediate delivery."
    : null;
  for (const operatorId of operatorIds) {
    const op = opsById?.get(operatorId) ?? (await repo.getOperator(operatorId));
    const user = op ? await repo.getUser(op.userId) : undefined;
    if (!user) continue;
    try {
      await emailProvider().send({
        to: user.email,
        subject,
        text:
          `You have a new request for quotation on ${site.name}.\n\n` +
          `${priorityLine ? `${priorityLine}\n\n` : ""}` +
          `${detailLines.join("\n")}\n` +
          `Buyer: ${buyerName}\n\n` +
          `Open your operator inbox to send a quote.`,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [
            `You have a new request for quotation on ${site.name}.`,
            ...(priorityLine ? [priorityLine] : []),
            ...detailLines,
            `Buyer: ${buyerName}`,
            "Open your operator inbox to send a quote.",
          ],
        }),
      });
    } catch (e) {
      logWarn("rfq.match_email_failed", {
        rfqId: rfq.id,
        operatorId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

/**
 * The "buyer amended their RFQ" operator email (QA-481) — same masked
 * field lines as the new-request build, different subject/intro so an op
 * doesn't mistake it for a second request. Goes to the PRE-amend visible
 * set only: operators the re-fan-out just matched get the normal new-RFQ
 * mail instead of an "updated" notice for a request they never saw.
 */
export async function emailRfqAmended(
  repo: Repo,
  rfq: Rfq,
  listingTitle: string | undefined,
  operatorIds: string[],
) {
  const { buyerName, detailLines, route } = rfqMailDetails(rfq.fields);
  const subject = ["Updated RFQ", route, listingTitle]
    .filter(Boolean)
    .join(" — ");
  for (const operatorId of operatorIds) {
    const op = await repo.getOperator(operatorId);
    const user = op ? await repo.getUser(op.userId) : undefined;
    if (!user) continue;
    try {
      await emailProvider().send({
        to: user.email,
        subject,
        text:
          `The buyer updated their request for quotation on ${site.name} — ` +
          `the latest details are below.\n\n` +
          `${detailLines.join("\n")}\n` +
          `Buyer: ${buyerName}\n\n` +
          `Open your operator inbox to review or quote.`,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [
            `The buyer updated their request for quotation on ${site.name} — the request below reflects the latest version.`,
            ...detailLines,
            `Buyer: ${buyerName}`,
            "Open your operator inbox to review or quote.",
          ],
        }),
      });
    } catch (e) {
      logWarn("rfq.amend_email_failed", {
        rfqId: rfq.id,
        operatorId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
