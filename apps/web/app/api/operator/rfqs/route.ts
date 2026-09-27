import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function GET() {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  const rfqs = await repo.listRfqs({ operatorId: operator.id });
  return ok(
    await Promise.all(
      rfqs.map(async (rfq) => ({
        // never leak the buyer bearer token — operators with it could
        // impersonate the buyer and accept their own quote (QA-41)
        ...{ ...rfq, accessToken: undefined },
        listing: (await repo.getListing(rfq.listingId)) ?? null,
        quotes: await repo.listQuotes({ rfqId: rfq.id }),
      })),
    ),
  );
}
