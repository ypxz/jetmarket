import { getAttributesSchema } from "@jetmarket/verticals";
import { storageProvider } from "@jetmarket/providers";
import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { FREE_LISTING_LIMIT } from "@/lib/fees";
import { getRepo } from "@/lib/repo";
import { logWarn } from "@/lib/log";
import { appOrigin } from "@/lib/origin";
import { isExpiredListing } from "@/lib/search";
import { alertSavedSearches } from "@/lib/search-alerts";
import { PlanCapError, publicOperator } from "@/lib/repo/types";
import { verticalConfig, verticalSlug } from "@/lib/vertical";

const PatchListing = z.object({
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
  title: z.string().min(3).max(200).optional(),
  price: z.number().positive().max(1e9).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  photos: z.array(z.string().max(300)).max(12).optional(),
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
  // Foreign-vertical rows are invisible — a machinery listing must not
  // render on a jets deploy (wrong facet labels, wrong RFQ schema).
  if (
    !listing ||
    listing.vertical !== verticalSlug() ||
    listing.status !== "active" ||
    isExpiredListing(listing)
  ) {
    return err("not found", 404);
  }
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
  // Cross-vertical writes on a shared DB would strip attributes — the
  // active vertical's schema has no fields for a foreign listing type.
  if (listing.vertical !== verticalSlug()) return err("not found", 404);
  if (!rateLimit(`listing-patch:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, PatchListing);
  if (error) return error;
  // Archive is terminal for operators — the UI offers no un-archive and an
  // admin-archived (moderated) listing must not come back on a PATCH, nor
  // through the archived→paused→active two-hop (QA-247). Paused → active
  // stays allowed: moderation pause is a nudge the operator fixes and
  // republishes under the plan cap (see below).
  if (
    listing.status === "archived" &&
    data!.status !== undefined &&
    data!.status !== "archived"
  ) {
    return err("archived listings can't be reactivated — contact support", 403);
  }
  // Validate EVERYTHING before writing — the status write used to run before
  // attribute/photo checks, so a rejected PATCH could still flip status.
  // Reactivating on the free plan still counts against the listing cap (QA-63);
  // the cap is enforced atomically inside updateListingStatus, not checked here.
  const cap =
    data!.status === "active" &&
    listing.status !== "active" &&
    operator.plan === "free"
      ? FREE_LISTING_LIMIT
      : undefined;
  const patch: Parameters<typeof repo.updateListing>[1] = {};
  if (data!.photos !== undefined) {
    // Same ownership rule as POST — photos may only reference this
    // operator's own uploads (QA-120).
    const photoPrefix = `uploads/${user.id}/`;
    if (data!.photos.some((k) => !k.startsWith(photoPrefix))) {
      return err("photos must come from your own uploads", 422);
    }
    patch.photos = data!.photos;
  }
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
  if (data!.status) {
    try {
      // cap enforces atomically under an operator row lock (QA-63 made it
      // check-then-act; concurrent creates could still slip past).
      await repo.updateListingStatus(id, data!.status, { cap });
    } catch (e) {
      if (e instanceof PlanCapError) {
        return err(
          `free plan allows ${FREE_LISTING_LIMIT} listings — upgrade to Pro`,
          403,
        );
      }
      throw e;
    }
  }
  if (Object.keys(patch).length) await repo.updateListing(id, patch);

  // Saved-search alerts (QA-403/404): run the probe on the FINAL row —
  // after both the status write and the attribute patch, so a
  // reactivate+edit PATCH matches on the new data and an attribute/price
  // edit on an already-live listing can newly satisfy a saved filter
  // (a price cut into a saved range would otherwise never mail).
  const becameActive = data!.status === "active" && listing.status !== "active";
  const liveEdit =
    listing.status === "active" &&
    (patch.attributes !== undefined ||
      patch.price !== undefined ||
      patch.title !== undefined);
  if (becameActive || liveEdit) {
    const fresh = await repo.getListing(id);
    if (fresh?.status === "active") {
      await alertSavedSearches(repo, fresh, appOrigin(req));
    }
  }
  if (patch.photos !== undefined) {
    // Orphan sweep: keys dropped by a photos replace would leak objects in
    // storage otherwise (data-growth scoping, same class as job pruning).
    // A key survives while ANY of the operator's listings still references
    // it — the same upload can be shared across their listings. Best-effort
    // like notify: a failed delete must not fail the PATCH.
    const dropped = listing.photos.filter((k) => !patch.photos!.includes(k));
    if (dropped.length) {
      try {
        const siblings = await repo.listListings({ operatorId: operator.id });
        const referenced = new Set(siblings.flatMap((l) => l.photos));
        const storage = storageProvider();
        for (const key of dropped) {
          if (referenced.has(key)) continue;
          try {
            await storage.delete(key);
          } catch {
            logWarn("storage.orphan_delete_failed", { key });
          }
        }
      } catch (e) {
        logWarn("storage.orphan_sweep_failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  return ok(await repo.getListing(id));
}
