import { captchaProvider, emailProvider, analyticsProvider } from "@jetmarket/providers";
import { z } from "zod";
import { buildRfqSchema, getVertical } from "@jetmarket/verticals";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
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

  const rfq = await repo.createRfq({
    vertical: listing.vertical,
    listingId,
    buyerEmail,
    fields: parsed.data,
  });

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
