import { getAttributesSchema } from "@jetmarket/verticals";
import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { FREE_LISTING_LIMIT } from "@/lib/fees";
import { getRepo } from "@/lib/repo";
import { publicOperator } from "@/lib/repo/types";
import { verticalConfig } from "@/lib/vertical";

const PatchListing = z.object({
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
  title: z.string().min(3).max(200).optional(),
  price: z.number().positive().max(1e9).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!rateLimit(`listing-get:${clientIp(req)}`, 600, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const repo = await getRepo();
  const listing = await repo.getListing(id);
  if (!listing || listing.status !== "active") return err("not found", 404);
  const op = await repo.getOperator(listing.operatorId);
  return ok({ ...listing, operator: op ? publicOperator(op) : null });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  const repo = await getRepo();
  const listing = await repo.getListing(id);
  const operator = await repo.getOperatorByUserId(user.id);
  if (!listing || !operator || listing.operatorId !== operator.id) {
    return err("not found", 404);
  }
  if (!rateLimit(`listing-patch:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, PatchListing);
  if (error) return error;
  if (data!.status) {
    // Reactivating on the free plan still counts against the listing cap —
    // the create route enforces it, PATCH must too (QA-63).
    if (
      data!.status === "active" &&
      listing.status !== "active" &&
      operator.plan === "free" &&
      (await repo.countOperatorListings(operator.id)) >= FREE_LISTING_LIMIT
    ) {
      return err(
        `free plan allows ${FREE_LISTING_LIMIT} listings — upgrade to Pro`,
        403,
      );
    }
    await repo.updateListingStatus(id, data!.status);
  }
  const patch: Parameters<typeof repo.updateListing>[1] = {};
  if (data!.title !== undefined) patch.title = data!.title;
  if (data!.price !== undefined) patch.price = data!.price;
  if (data!.attributes !== undefined) {
    // Same per-type attribute contract as create — partial, so callers may
    // send only the keys they're changing.
    const attrs = getAttributesSchema(verticalConfig(), listing.type)
      .partial()
      .safeParse({ ...listing.attributes, ...data!.attributes });
    if (!attrs.success) return err("invalid attributes", 422, attrs.error.issues);
    patch.attributes = attrs.data;
  }
  if (Object.keys(patch).length) await repo.updateListing(id, patch);
  return ok(await repo.getListing(id));
}
