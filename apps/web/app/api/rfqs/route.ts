import { createHash } from "node:crypto";
import { captchaProvider, emailProvider, analyticsProvider } from "@jetmarket/providers";
import { z } from "zod";
import { buildRfqSchema, getVertical } from "@jetmarket/verticals";
import { clientIp, err, isUniqueViolation, ok, parseBody, rateLimit } from "@/lib/api";
import { fanoutRfq } from "@/lib/fanout";
import { logInfo, logWarn } from "@/lib/log";
import { getRepo } from "@/lib/repo";
import { getDbSql } from "@/lib/repo/drizzle";
import { enqueueJob } from "@jetmarket/db";

const CreateRfq = z.object({
  listingId: z.string().min(1),
  buyerEmail: z.string().email(),
  fields: z.record(z.string(), z.unknown()).default({}),
  // honeypot — must stay empty; bots filling it are silently dropped.
  website: z.string().optional(),
  // captcha token from the widget (cf-turnstile-response) — mock provider
  // always passes; turnstile verifies server-side.
  captchaToken: z.string().optional(),
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

  const captcha = await captchaProvider().verify(captchaToken, ip);
  if (!captcha.success) {
    logWarn("rfq.captcha_failed", { ip, reason: captcha.reason });
    return err("verification failed — please retry", 403);
  }

  const repo = await getRepo();
  const listing = await repo.getListing(listingId);
  if (!listing || listing.status !== "active") return err("listing not found", 404);

  // RFQ payload shape comes from the active vertical's rfqFields config.
  const parsed = buildRfqSchema(getVertical()).safeParse(fields);
  if (!parsed.success) return err("invalid fields", 422, parsed.error.issues);

  // Idempotent submit: dedupe key = sha256(listing|email|canonical fields).
  // Double-click, refresh-resubmit, or retried concurrent POSTs all collide
  // on the unique index instead of minting duplicate RFQs/owner emails.
  const dedupeKey = createHash("sha256")
    .update(`${listingId}|${buyerEmail.toLowerCase()}|${canonicalize(parsed.data)}`)
    .digest("hex");
  let rfq;
  let deduped = false;
  try {
    rfq = await repo.createRfq({
      vertical: listing.vertical,
      listingId,
      buyerEmail,
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
  // depend on the worker being up.
  const operator = await repo.getOperator(listing.operatorId);
  const owner = operator ? await repo.getUser(operator.userId) : undefined;
  if (owner) {
    await emailProvider().send({
      to: owner.email,
      subject: `New RFQ on “${listing.title}”`,
      text: `Buyer ${buyerEmail} sent a request. Fields: ${JSON.stringify(fields)}`,
    });
  }

  if (process.env.DATABASE_URL) {
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
    // multi-operator loop (QA-89).
    await fanoutRfq(repo, rfq, listing);
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
