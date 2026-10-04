import { analyticsProvider } from "@jetmarket/providers";
import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { FREE_LISTING_LIMIT } from "@/lib/fees";
import { getRepo } from "@/lib/repo";
import { PlanCapError } from "@/lib/repo/types";
import { verticalSlug } from "@/lib/vertical";

/**
 * POST /api/listings/[id]/duplicate — clone an owned listing into a new
 * DRAFT (QA-412). Revive path for archived rows and the "same aircraft,
 * new leg" workflow: every field carries over, nothing publishes until
 * the operator reviews and activates it. The plan cap applies — a clone
 * consumes the same slot a fresh listing would.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("operator");
  if (!user) return err("sign in as an operator first", 401);
  if (!rateLimit(`listing:dup:${clientIp(req)}`, 40, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  const { id } = await params;
  const listing = await repo.getListing(id);
  if (!listing || !operator || listing.operatorId !== operator.id) {
    return err("not found", 404);
  }
  if (listing.vertical !== verticalSlug()) return err("not found", 404);

  const title = `${listing.title.slice(0, 153)} (copy)`;
  try {
    const copy = await repo.createListing(
      {
        operatorId: operator.id,
        vertical: listing.vertical,
        type: listing.type,
        title,
        attributes: listing.attributes,
        price: listing.price,
        currency: listing.currency,
        photos: listing.photos,
        // Draft is the create default — set explicitly anyway so a future
        // 'auto-publish' default can't resurrect an archive silently.
        status: "draft",
      },
      { cap: operator.plan === "free" ? FREE_LISTING_LIMIT : undefined },
    );
    analyticsProvider().track({
      name: "listing_duplicated",
      props: { sourceId: listing.id, listingId: copy.id, vertical: listing.vertical },
    });
    return ok(copy, 201);
  } catch (e) {
    if (e instanceof PlanCapError) {
      return err(
        `free plan allows ${FREE_LISTING_LIMIT} listings — upgrade to Pro`,
        402,
        { upgrade: true },
      );
    }
    throw e;
  }
}
