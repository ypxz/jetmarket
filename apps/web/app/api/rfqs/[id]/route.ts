import { z } from "zod";
import { analyticsProvider } from "@jetmarket/providers";
import { enqueueJob } from "@jetmarket/db";
import { buildRfqSchema, getVertical } from "@jetmarket/verticals";
import { clientIp, err, isUniqueViolation, ok, parseBody, rateLimit } from "@/lib/api";
import { logInfo, logWarn } from "@/lib/log";
import { getRepo, repoBackend } from "@/lib/repo";
import { getDbSql } from "@/lib/repo/drizzle";
import { verticalSlug } from "@/lib/vertical";
import { buyerAuthorized } from "@/lib/buyer-auth";
import { rfqAmendDedupeKey } from "@/lib/rfq-dedupe";
import { emailRfqAmended, fanoutRfq } from "@/lib/fanout";

const AmendRfq = z.object({
  buyerEmail: z.string().email().max(254),
  token: z.string().max(256).optional().default(""),
  fields: z.record(z.string(), z.unknown()),
});

/** Buyer request amendment (QA-481): a typo'd route/date/pax shouldn't
 *  force close+repost — reposting mints a fresh RFQ and abandons the
 *  delivered-to history and live quotes. PATCH replaces `fields` on a
 *  LIVE rfq (CAS-gated like close), re-keys the dedupe hash to the new
 *  content, re-runs fan-out so newly-fitting operators get their match,
 *  and mails the operators who already received it (the pre-amend
 *  delivered set — newly matched ops get the ordinary new-RFQ mail). */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!rateLimit(`rfq-amend:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, AmendRfq);
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

  // Delivered-match holders BEFORE the re-fan-out below inserts fresh
  // pairs — this is the "you already saw it" set that hears about the
  // edit. Dismissals are filtered inside the repo call (they opted out).
  const notifyIds = await repo.listRfqMatchOperatorIds(rfq.id);
  const listing = rfq.listingId
    ? await repo.getListing(rfq.listingId)
    : undefined;
  const owner = listing ? await repo.getOperator(listing.operatorId) : undefined;

  // Same validation + normalization as POST — the stored map is the
  // zod-parsed one and the dedupe hash rides on it (hash contract).
  // Orphaned requests (listing deleted) have no schema to check against
  // and accept the body shape verbatim.
  let fields: Record<string, unknown> = data!.fields;
  if (listing) {
    const parsed = buildRfqSchema(
      getVertical(),
      listing.type,
    ).safeParse(data!.fields);
    if (!parsed.success) return err("invalid fields", 422, parsed.error.issues);
    fields = parsed.data;
  }

  const dedupeKey = rfqAmendDedupeKey(
    rfq.listingId ?? "",
    rfq.buyerEmail,
    fields,
  );
  try {
    if (!(await repo.updateRfqFields(rfq.id, fields, dedupeKey))) {
      return err("rfq is no longer open", 409);
    }
  } catch (e) {
    // The recomputed key hit a DIFFERENT live twin — the edit would make
    // this request an exact duplicate of one the buyer already has open.
    if (isUniqueViolation(e)) {
      return err("you already have a live request with these details", 409);
    }
    throw e;
  }

  const updated = { ...rfq, fields };

  // Re-fan-out so operators the NEW details fit (and the old ones didn't)
  // get their match. Same split as create: pg enqueues the worker job
  // (its gate now admits live statuses — terminal RFQs still bail),
  // memory runs the match inline. Delivery is deduped — existing match
  // pairs are untouched, only new fits get rows + the new-RFQ mail.
  if (repoBackend() === "postgres") {
    try {
      await enqueueJob(getDbSql(), "rfq.fanout", { rfqId: rfq.id }, {
        vertical: rfq.vertical,
      });
    } catch (e) {
      logWarn("rfq.refanout_enqueue_failed", {
        rfqId: rfq.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  } else if (listing) {
    try {
      await fanoutRfq(repo, updated, listing);
    } catch (e) {
      logWarn("rfq.refanout_failed", {
        rfqId: rfq.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // The already-delivered set + the listing owner (no match row — the
  // self-match exclusion means they only ever get direct notices).
  // Suspended operators can't act on it — skip their mail too.
  const mailIds = new Set(notifyIds);
  if (owner) mailIds.add(owner.id);
  const mailTargets = (
    await Promise.all(mailIds.size ? [...mailIds].map((o) => repo.getOperator(o)) : [])
  ).filter((o): o is NonNullable<typeof o> => !!o && !o.suspended);
  try {
    await emailRfqAmended(
      repo,
      updated,
      listing?.title,
      mailTargets.map((o) => o.id),
      // pre-amend fields — the mail leads with an old → new diff (QA-482)
      rfq.fields,
    );
  } catch (e) {
    logWarn("rfq.amend_notify_failed", {
      rfqId: rfq.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  logInfo("rfq.amended", { rfqId: rfq.id, notified: mailTargets.length });
  analyticsProvider().track({
    name: "rfq_amended",
    props: { rfqId: rfq.id, notified: mailTargets.length },
  });
  return ok({ id: rfq.id, amended: true });
}
