import { z } from "zod";
import { analyticsProvider } from "@jetmarket/providers";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { emailRfqAmended } from "@/lib/fanout";
import { logInfo, logWarn } from "@/lib/log";
import { getRepo } from "@/lib/repo";
import { rfqDeadlineAt } from "@/lib/rfq-deadline";
import { verticalSlug } from "@/lib/vertical";
import { buyerAuthorized } from "@/lib/buyer-auth";

const ExtendRfq = z.object({
  buyerEmail: z.string().email().max(254),
  token: z.string().max(256).optional().default(""),
});

const DAY_MS = 86_400_000;

/** Buyer-initiated extend (QA-446): one click buys a week — the request's
 *  close date becomes today+7 UTC, never a backward move, and refused when
 *  the QA-442 horizon already sits ≥8 days out (nothing to extend).
 *  Extending in place keeps the delivered-to history and any live quotes
 *  that a repost (QA-410's minted twin) would leave behind. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!rateLimit(`rfq-extend:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, ExtendRfq);
  if (error) return error;
  const { id } = await params;
  const repo = await getRepo();
  const rfq = await repo.getRfq(id);
  if (
    !rfq ||
    rfq.vertical !== verticalSlug() ||
    !(await buyerAuthorized(rfq, data!))
  ) {
    return err("not found", 404);
  }
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const target = new Date(today.getTime() + 7 * DAY_MS);
  // Extending sets dateTo = today+7 → deadline today+8. A request whose
  // current horizon already reaches that has nothing to gain.
  const current = rfqDeadlineAt(rfq);
  if (current.getTime() >= target.getTime() + DAY_MS) {
    return err("request already has at least a week left", 409);
  }
  const dateTo = target.toISOString().slice(0, 10);
  // The delivered set + listing owner get the amended mail — an extension
  // IS a one-field amendment (dateTo): the QA-482 diff mail leads with
  // "dateTo: old → new". Read them BEFORE the CAS so the pre-write fields
  // diff against the new map (QA-484 — extends used to bump the Updated
  // badge but mail nobody).
  const notifyIds = await repo.listRfqMatchOperatorIds(rfq.id);
  const listing = rfq.listingId
    ? await repo.getListing(rfq.listingId)
    : undefined;
  const owner = listing ? await repo.getOperator(listing.operatorId) : undefined;
  // CAS: a terminal flip between read and write refuses to re-date.
  if (!(await repo.extendRfqDeadline(id, dateTo))) {
    return err("rfq is no longer open", 409);
  }
  const mailIds = new Set(notifyIds);
  if (owner) mailIds.add(owner.id);
  const mailTargets = (
    await Promise.all(
      mailIds.size ? [...mailIds].map((o) => repo.getOperator(o)) : [],
    )
  ).filter((o): o is NonNullable<typeof o> => !!o && !o.suspended);
  const updated = { ...rfq, fields: { ...rfq.fields, dateTo } };
  try {
    await emailRfqAmended(
      repo,
      updated,
      listing?.title,
      mailTargets.map((o) => o.id),
      rfq.fields,
    );
  } catch (e) {
    logWarn("rfq.extend_notify_failed", {
      rfqId: rfq.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  logInfo("rfq.extended_by_buyer", { rfqId: rfq.id, dateTo });
  analyticsProvider().track({
    name: "rfq_extended",
    props: { rfqId: rfq.id, dateTo },
  });
  return ok({ id: rfq.id, dateTo });
}
