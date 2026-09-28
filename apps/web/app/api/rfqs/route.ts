import { createHash } from "node:crypto";
import { brandedEmailHtml, captchaProvider, emailProvider, analyticsProvider } from "@jetmarket/providers";
import { site } from "@jetmarket/config";
import { z } from "zod";
import { buildRfqSchema, getVertical, nonContactFields, rfqFieldLabels } from "@jetmarket/verticals";
import { verticalMessages } from "@/lib/vertical";
import { clientIp, err, isUniqueViolation, ok, parseBody, rateLimit } from "@/lib/api";
import { fanoutRfq } from "@/lib/fanout";
import { logInfo, logWarn } from "@/lib/log";
import { getRepo, repoBackend } from "@/lib/repo";
import { isExpiredListing } from "@/lib/search";
import { getDbSql } from "@/lib/repo/drizzle";
import { enqueueJob } from "@jetmarket/db";
import { appOrigin } from "@/lib/origin";

const CreateRfq = z.object({
  listingId: z.string().min(1).max(64),
  buyerEmail: z.string().email().max(254),
  fields: z.record(z.string(), z.unknown()).default({}),
  // honeypot — must stay empty; bots filling it are silently dropped.
  website: z.string().max(512).optional(),
  // captcha token from the widget (cf-turnstile-response) — mock provider
  // always passes; turnstile verifies server-side.
  captchaToken: z.string().max(4096).optional(),
});

/** Stable stringify: sorted object keys so field order never defeats dedupe. */
function canonicalize(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  const limit = Number(process.env.RFQ_RATE_LIMIT_PER_HOUR ?? 5);
  if (!rateLimit(`rfq:${ip}`, limit, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }

  const { data, error } = await parseBody(req, CreateRfq);
  if (error) return error;
  const { listingId, buyerEmail, fields, website, captchaToken } = data!;
  if (website) return ok({ received: true }, 201); // honeypot hit: fake success

  const repo = await getRepo();
  const listing = await repo.getListing(listingId);
  // Foreign-vertical listings 404 here too — a shared-DB machinery row must
  // not accept RFQs on a jets deploy (its fields would fail/mangle the
  // active vertical's schema).
  if (
    !listing ||
    listing.vertical !== getVertical().slug ||
    listing.status !== "active" ||
    isExpiredListing(listing)
  ) {
    // Expired dated inventory is unbookable — same 404 as a withdrawn listing.
    return err("listing not found", 404);
  }

  // RFQ payload shape comes from the active vertical's rfqFields config,
  // scoped to this listing's type — an aircraft_sale inquiry has no trip
  // dates/passengers (QA-147).
  const parsed = buildRfqSchema(getVertical(), listing.type).safeParse(fields);
  if (!parsed.success) return err("invalid fields", 422, parsed.error.issues);

  // Idempotent submit: dedupe key = sha256(listing|email|canonical fields).
  // Double-click, refresh-resubmit, or retried concurrent POSTs all collide
  // on the unique index instead of minting duplicate RFQs/owner emails.
  // Dedupe is live-scoped — once the earlier RFQ closes, the same payload
  // mints a fresh request rather than replaying the dead one (QA-228).
  // Email is normalized at write — inbox lookup + accept/decline compare
  // case-insensitively (QA-153). The dedupe read runs BEFORE captcha:
  // turnstile tokens are single-use, so a retry of an already-persisted
  // submit would fail the second siteverify and show "verification failed"
  // to a buyer whose RFQ actually landed (QA-176).
  const dedupeKey = createHash("sha256")
    .update(`${listingId}|${buyerEmail.toLowerCase()}|${canonicalize(parsed.data)}`)
    .digest("hex");
  const replay = await repo.getRfqByDedupeKey(dedupeKey);
  if (replay) {
    // Same response as the post-insert dedupe path — rfqId only, never the
    // bearer token.
    return ok({ received: true, rfqId: replay.id, deduped: true }, 200);
  }

  const captcha = await captchaProvider().verify(captchaToken, ip);
  if (!captcha.success) {
    logWarn("rfq.captcha_failed", { ip, reason: captcha.reason });
    return err("verification failed — please retry", 403);
  }
  let rfq;
  let deduped = false;
  try {
    rfq = await repo.createRfq({
      vertical: listing.vertical,
      listingId,
      buyerEmail: buyerEmail.toLowerCase(),
      fields: parsed.data,
      dedupeKey,
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const existing = await repo.getRfqByDedupeKey(dedupeKey);
      if (!existing) throw e;
      rfq = existing;
      deduped = true;
    } else {
      throw e;
    }
  }
  if (deduped) {
    // No accessToken on replay: the POST is unauthenticated, and re-emitting
    // the buyer bearer token to anyone who can guess the same payload would
    // leak the quote inbox. The original requester already got it once.
    return ok({ received: true, rfqId: rfq.id, deduped: true }, 200);
  }

  // The listing owner gets the direct notice in every mode — it must not
  // depend on the worker being up. Contact fields (email/tel) are masked —
  // the intro is the fee, so contact happens only after deal-close (QA-152).
  const operator = await repo.getOperator(listing.operatorId);
  const owner = operator ? await repo.getUser(operator.userId) : undefined;
  if (owner) {
    const buyerName =
      typeof parsed.data["name"] === "string" ? parsed.data["name"] : "A buyer";
    const publicFields = nonContactFields(getVertical(), listing.type, parsed.data);
    // Labeled detail lines (QA-235) — was a raw JSON.stringify of field keys.
    const labels = rfqFieldLabels(getVertical(), verticalMessages());
    const detailLines = Object.entries(publicFields).map(
      ([k, v]) => `${labels.get(k) ?? k}: ${String(v)}`,
    );
    // A provider blip must not 500 the buyer — the RFQ is already persisted
    // (a retry dedupes to 200 via dedupeKey, so the buyer never loses it).
    try {
      const subject = `New RFQ on “${listing.title}”`;
      const body = `${buyerName} sent a request.`;
      await emailProvider().send({
        to: owner.email,
        subject,
        text: `${body}\n\n${detailLines.join("\n")}`,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [body, ...detailLines],
        }),
      });
    } catch (e) {
      logWarn("rfq.owner_notify_failed", {
        rfqId: rfq.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Buyer confirmation: the inbox link (bearer token) otherwise lives only in
  // this POST's response — a lost response strands the buyer with no recovery
  // path. The mail is boilerplate + listing title (no submitted fields), so a
  // bogus buyerEmail can't weaponize it beyond "someone used your address".
  // Token goes only to the claimed mailbox — same model as magic links.
  const appUrl = appOrigin(req);
  const inboxUrl = `${appUrl}/quotes?email=${encodeURIComponent(
    rfq.buyerEmail,
  )}#t=${encodeURIComponent(rfq.accessToken)}`;
  try {
    const subject = `Your request for “${listing.title}” was sent`;
    await emailProvider().send({
      to: rfq.buyerEmail,
      subject,
      text: `We sent your request to the seller and matching operators. Track their quotes here: ${inboxUrl}`,
      html: brandedEmailHtml({
        siteName: site.name,
        title: subject,
        paragraphs: [
          "We sent your request to the seller and matching operators.",
        ],
        cta: { url: inboxUrl, label: "Track your quotes" },
      }),
    });
  } catch (e) {
    logWarn("rfq.buyer_confirm_failed", {
      rfqId: rfq.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  if (repoBackend() === "postgres") {
    // Postgres mode: the worker fans the RFQ out to matched operators. A job
    // enqueue failure must not 500 the buyer — the RFQ is already persisted
    // and the owner was notified; the RFQ just stays `new` until a fan-out
    // retry (logged for ops).
    try {
      await enqueueJob(getDbSql(), "rfq.fanout", { rfqId: rfq.id });
    } catch (e) {
      logWarn("rfq.fanout_enqueue_failed", {
        rfqId: rfq.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  } else {
    // Memory mode has no worker — fan out inline so mock demos exercise the
    // multi-operator loop (QA-89). Same resilience as the enqueue path: the
    // RFQ is persisted, so a match failure must not 500 the buyer (QA-155).
    try {
      await fanoutRfq(repo, rfq, listing);
    } catch (e) {
      logWarn("rfq.fanout_failed", {
        rfqId: rfq.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  logInfo("rfq.created", {
    rfqId: rfq.id,
    listingId,
    vertical: listing.vertical,
  });
  analyticsProvider().track({
    name: "rfq_created",
    props: { rfqId: rfq.id, listingId, vertical: listing.vertical },
  });
  return ok(
    { received: true, rfqId: rfq.id, accessToken: rfq.accessToken },
    201,
  );
}
