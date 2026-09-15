import { err, ok } from "@/lib/api";
import { getRepo } from "@/lib/repo";

// Buyer-side view: quotes received for their RFQs. Mock-mode identity = email
// param (spec fallback: quotes visible in buyer's magic-link page instead of
// inbox). TODO: gate by magic-link session once auth real.ts lands.
export async function GET(req: Request) {
  const email = new URL(req.url).searchParams.get("email");
  if (!email) return err("email required", 400);
  const repo = getRepo();
  const rfqs = repo.listRfqs({ buyerEmail: email });
  return ok(
    rfqs.map((r) => ({
      ...r,
      listing: repo.getListing(r.listingId) ?? null,
      quotes: repo.listQuotes({ rfqId: r.id }).map((q) => ({
        ...q,
        operator: repo.getOperator(q.operatorId) ?? null,
      })),
    })),
  );
}
