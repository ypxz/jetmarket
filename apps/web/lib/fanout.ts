import { defaultPlans, deliverAt, matchOperators } from "@jetmarket/domain";
import { site } from "@jetmarket/config";
import type { OperatorCandidate } from "@jetmarket/domain";
import { emailProvider } from "@jetmarket/providers";
import { logWarn } from "@/lib/log";
import type { Listing, Repo, Rfq } from "@/lib/repo/types";

/**
 * Memory-mode RFQ fan-out — the worker only exists in pg mode, so mock demos
 * would otherwise notify nobody but the listing owner. Runs the same domain
 * matching inline; delayed matches carry `deliverAt` and surface once due
 * (the memory repo checks lazily on read — no sweep needed).
 */
export async function fanoutRfq(repo: Repo, rfq: Rfq, listing: Listing) {
  const ops = await repo.listOperators();
  const candidates: OperatorCandidate[] = await Promise.all(
    ops.map(async (o) => ({
      id: o.id,
      verified: o.verified,
      planId: o.plan,
      baseAirport: o.baseAirport,
      // Fleet mirrors the worker's loadOperatorCandidates: charter listings'
      // aircraftCategory/seats.
      fleet: (
        await repo.listListings({
          operatorId: o.id,
          status: "active",
          type: "charter",
        })
      ).map((l) => {
        const a = l.attributes;
        return {
          listingId: l.id,
          category:
            typeof a["aircraftCategory"] === "string"
              ? a["aircraftCategory"]
              : undefined,
          seats: typeof a["seats"] === "number" ? a["seats"] : undefined,
        };
      }),
    })),
  );
  const matches = matchOperators(rfq.fields, candidates, defaultPlans(), {
    limit: 10,
    excludeOperatorIds: new Set([listing.operatorId]),
  });
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
  const route = [f["departure"] ?? f["from"], f["arrival"] ?? f["to"]]
    .filter(Boolean)
    .join(" → ");
  const pax = f["passengers"] ? ` — ${String(f["passengers"])} pax` : "";
  const opsById = new Map(ops.map((o) => [o.id, o]));
  // Buyer contact stays masked until a deal closes (QA-152) — name only,
  // same masking the worker's quote_notification applies in pg mode.
  const buyerName =
    typeof f["name"] === "string" && f["name"].trim() ? f["name"] : "A buyer";
  for (const m of matches) {
    if (m.delivery === "delayed") continue;
    const op = opsById.get(m.operatorId);
    const user = op ? await repo.getUser(op.userId) : undefined;
    if (!user) continue;
    try {
      await emailProvider().send({
        to: user.email,
        subject: `New RFQ ${route}${pax}`.trim(),
        text:
          `You have a new request for quotation on ${site.name}.\n\n` +
          `Route: ${route || "n/a"}${pax}\n` +
          `Dates: ${String(f["dateFrom"] ?? "")} – ${String(f["dateTo"] ?? "")}\n` +
          `Buyer: ${buyerName}\n\n` +
          `Open your operator inbox to send a quote.`,
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
