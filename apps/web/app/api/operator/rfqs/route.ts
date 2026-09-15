import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function GET() {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  const repo = getRepo();
  const operator = repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  const rfqs = repo.listRfqs({ operatorId: operator.id });
  return ok(
    rfqs.map((r) => ({
      ...r,
      listing: repo.getListing(r.listingId) ?? null,
      quotes: repo.listQuotes({ rfqId: r.id }),
    })),
  );
}
