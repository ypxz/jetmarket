import { err, ok } from "@/lib/api";
import { getRepo } from "@/lib/repo";

// Buyer-side view: quotes received for their RFQs. Mock-mode identity = email
// param (spec fallback: quotes visible in buyer's magic-link page instead of
// inbox). TODO: gate by magic-link session once auth real.ts lands.
export async function GET(req: Request) {
  const email = new URL(req.url).searchParams.get("email");
  if (!email) return err("email required", 400);
  const repo = await getRepo();
  const rfqs = await repo.listRfqs({ buyerEmail: email });
  return ok(
    await Promise.all(
      rfqs.map(async (r) => ({
        ...r,
        listing: (await repo.getListing(r.listingId)) ?? null,
        quotes: await Promise.all(
          (await repo.listQuotes({ rfqId: r.id })).map(async (q) => ({
            ...q,
            operator: (await repo.getOperator(q.operatorId)) ?? null,
          })),
        ),
      })),
    ),
  );
}
