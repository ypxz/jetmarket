import { z } from "zod";
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

  const repo = getRepo();
  const listing = repo.getListing(listingId);
  if (!listing || listing.status !== "active") return err("listing not found", 404);

  const rfq = repo.createRfq({
    vertical: listing.vertical,
    listingId,
    buyerEmail,
    fields: fields ?? {},
  });

  const operator = repo.getOperator(listing.operatorId);
  if (operator) {
    const owner = repo.getUser(operator.userId);
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
