import { deliverAt, matchOperators } from "@jetmarket/domain";
import { rfqFieldLabels } from "@jetmarket/verticals";
import { signOpUnsub, site } from "@jetmarket/config";
import { verticalConfig, verticalMessagesFor } from "@/lib/vertical";
import { mailCopy, mailT } from "@jetmarket/i18n";
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
 *  the route string the subject carries. `prev` (QA-482) adds a
 *  "Label: old → new" diff of just the changed fields — the amend mail
 *  leads with it so operators spot the delta instead of re-reading
 *  every line. */
// QA-494: the fan-out mails render in each recipient's users.locale, so the
// caller resolves field labels + the generic buyer fallback per-recipient.
const mailLabelCache = new Map<string, Map<string, string>>();
async function mailFieldLabels(locale: string): Promise<Map<string, string>> {
  let hit = mailLabelCache.get(locale);
  if (!hit) {
    hit = rfqFieldLabels(verticalConfig(), await verticalMessagesFor(locale));
    mailLabelCache.set(locale, hit);
  }
  return hit;
}

function rfqMailDetails(
  f: Record<string, unknown>,
  labels: ReadonlyMap<string, string>,
  aBuyer: string,
  prev?: Record<string, unknown>,
) {
  // Buyer contact stays masked until a deal closes (QA-152) — name only.
  const buyerName =
    typeof f["name"] === "string" && f["name"].trim() ? f["name"] : aBuyer;
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
  // Union over old+new keys so a REMOVED field diffs too ("Old → —").
  const diffKeys = prev
    ? [
        ...detailKeys,
        ...Object.keys(prev).filter(
          (k) => !CONTACT_KEYS.has(k) && !detailKeys.includes(k),
        ),
      ]
    : [];
  const changedLines = diffKeys
    .map((k) => {
      const blank = (v: unknown) =>
        v === undefined || v === null || String(v) === "";
      const before = blank(prev![k]) ? "—" : String(prev![k]);
      const after = blank(f[k]) ? "—" : String(f[k]);
      return before === after ? null : `${labels.get(k) ?? k}: ${before} → ${after}`;
    })
    .filter((x): x is string => x !== null);
  const route = [f["departure"] ?? f["from"], f["arrival"] ?? f["to"]]
    .filter(Boolean)
    .join(" → ");
  return { buyerName, detailLines, changedLines, route };
}

export async function emailRfqMatches(
  repo: Repo,
  rfq: Rfq,
  listingTitle: string | undefined,
  operatorIds: string[],
  opsById?: Map<string, Operator>,
) {
  const f = rfq.fields;
  // QA-494: each operator's mail renders in their users.locale — subject,
  // field labels, and the masked-buyer fallback all resolve per-recipient.
  for (const operatorId of operatorIds) {
    const op = opsById?.get(operatorId) ?? (await repo.getOperator(operatorId));
    // QA-505: muted mail switch — the match row still delivered; skip only
    // the email leg (same gate as the worker's quote_notification handler).
    if (op && !op.notifyRfqMatch) continue;
    const user = op ? await repo.getUser(op.userId) : undefined;
    if (!user) continue;
    const m = await mailCopy(user.locale);
    const { buyerName, detailLines, route } = rfqMailDetails(
      f,
      await mailFieldLabels(user.locale),
      mailT(m, "shared.aBuyer"),
    );
    const subject = [mailT(m, "rfqNew.subject"), route, listingTitle]
      .filter(Boolean)
      .join(" — ");
    // Concierge RFQs are paid expedites — flag them so operators quote first
    // (same line the worker's email.quote_notification adds in pg mode).
    const priorityLine = rfq.concierge
      ? mailT(m, "rfqNew.priority")
      : null;
    const intro = mailT(m, "rfqNew.intro", { site: site.name });
    const buyerLine = mailT(m, "rfqNew.buyer", { name: buyerName });
    const cta = mailT(m, "rfqNew.cta");
    // QA-541: match mail carries its own opt-out — the signed token
    // proves the mailbox without a session (same footer the worker's
    // email.quote_notification composes in pg mode).
    const unsub = `${process.env.APP_URL?.replace(/\/+$/, "") ?? `https://${site.domain}`}/api/operator/notify/unsubscribe?token=${encodeURIComponent(signOpUnsub(operatorId))}`;
    const unsubLine = `${mailT(m, "rfqNew.unsub")}: ${unsub}`;
    try {
      await emailProvider().send({
        to: user.email,
        subject,
        text:
          `${intro}\n\n` +
          `${priorityLine ? `${priorityLine}\n\n` : ""}` +
          `${detailLines.join("\n")}\n` +
          `${buyerLine}\n\n` +
          `${cta}\n\n` +
          unsubLine,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [
            intro,
            ...(priorityLine ? [priorityLine] : []),
            ...detailLines,
            buyerLine,
            cta,
            unsubLine,
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
  prevFields?: Record<string, unknown>,
) {
  for (const operatorId of operatorIds) {
    const op = await repo.getOperator(operatorId);
    // QA-505: same mute as the new-request mail — an amend mail to an
    // opted-out op is still just fan-out volume.
    if (op && !op.notifyRfqMatch) continue;
    const user = op ? await repo.getUser(op.userId) : undefined;
    if (!user) continue;
    // QA-494: per-recipient locale — labels, delta lines, intro, CTA.
    const m = await mailCopy(user.locale);
    const { buyerName, detailLines, changedLines, route } = rfqMailDetails(
      rfq.fields,
      await mailFieldLabels(user.locale),
      mailT(m, "shared.aBuyer"),
      prevFields,
    );
    const subject = [mailT(m, "rfqAmended.subject"), route, listingTitle]
      .filter(Boolean)
      .join(" — ");
    // Lead with the delta when the caller supplies the pre-amend fields —
    // "Departure: ZRH → GVA" answers "what changed?" in one glance. A no-op
    // edit or missing prev falls back to the full detail lines.
    const bodyLines = changedLines.length > 0 ? changedLines : detailLines;
    const intro =
      changedLines.length > 0
        ? mailT(m, "rfqAmended.introChanged", { site: site.name })
        : mailT(m, "rfqAmended.introLatest", { site: site.name });
    const buyerLine = mailT(m, "rfqAmended.buyer", { name: buyerName });
    const cta = mailT(m, "rfqAmended.cta");
    try {
      await emailProvider().send({
        to: user.email,
        subject,
        text:
          `${intro}\n\n` +
          `${bodyLines.join("\n")}\n` +
          `${buyerLine}\n\n` +
          cta,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [
            intro,
            ...bodyLines,
            buyerLine,
            cta,
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
