import { z } from "zod";
import { buildRfqSchema, getVertical } from "@jetmarket/verticals";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { sendMail } from "@/lib/outbox";
import { getRepo } from "@/lib/repo";

const CreateRfq = z.object({
  listingId: z.string().min(1),
  buyerEmail: z.string().email(),
  fields: z.record(z.string(), z.unknown()).default({}),
  // honeypot — must stay empty; bots filling it are silently dropped.
  website: z.string().optional(),
});

export async function POST(req: Request) {
  const limit = Number(process.env.RFQ_RATE_LIMIT_PER_HOUR ?? 5);
  if (!rateLimit(`rfq:${clientIp(req)}`, limit, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }

  const { data, error } = await parseBody(req, CreateRfq);
  if (error) return error;
  const { listingId, buyerEmail, fields, website } = data!;
  if (website) return ok({ received: true }, 201); // honeypot hit: fake success

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

  const operator = await repo.getOperator(listing.operatorId);
  if (operator) {
    const owner = await repo.getUser(operator.userId);
    if (owner) {
      await sendMail(
        owner.email,
        `New RFQ on “${listing.title}”`,
        `Buyer ${buyerEmail} sent a request. Fields: ${JSON.stringify(fields)}`,
      );
    }
  }
  return ok({ received: true, rfqId: rfq.id }, 201);
}
