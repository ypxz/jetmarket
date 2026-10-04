import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo, logWarn } from "@/lib/log";
import { auditAdmin } from "@/lib/audit";
import { notifyListingModerated } from "@/lib/notify";
import { getRepo } from "@/lib/repo";
import { endListingWatches } from "@/lib/search-alerts";
import { closeListingRfqs } from "@/lib/sweep";
import { appOrigin } from "@/lib/origin";
import { verticalSlug } from "@/lib/vertical";

const ModerateListing = z.object({
  // Down-moderation only — activation stays operator-owned (plan cap applies).
  status: z.enum(["paused", "archived"]),
});

/** Admin listing moderation (QA-157): pause/archive a listing that violates
 *  policy. Reactivation is left to the operator so the plan cap still binds. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (!rateLimit(`admin-listing-mod:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, ModerateListing);
  if (error) return error;
  const { id } = await params;
  const repo = await getRepo();
  const listing = await repo.getListing(id);
  // Per-vertical admin boundary (QA-296): same shared-DB rule as RFQs.
  if (!listing || listing.vertical !== verticalSlug())
    return err("not found", 404);
  await repo.updateListingStatus(id, data!.status);
  // QA-462: archiving a reported listing auto-clears its open flags —
  // the enforcement the flag asked for just happened. Pauses stay open.
  const cleared =
    data!.status === "archived"
      ? await repo.resolveListingReportsForListing(id)
      : 0;
  // Owner gets a moderation email — a listing silently vanishing from
  // search was the QA-247 gap. Fire-and-forget; never fails the request.
  await notifyListingModerated(repo, listing, data!.status);
  // QA-499: a moderated listing exits the market exactly like an operator
  // archive — watches end and the orphaned live RFQs close (their sent
  // quotes decline). Both teardowns are non-fatal like notify.
  if (data!.status === "archived") {
    try {
      await endListingWatches(repo, listing, appOrigin(req));
      await closeListingRfqs(repo, listing, appOrigin(req));
    } catch (e) {
      logWarn("admin.listing_teardown_failed", {
        listingId: id,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  logInfo("admin.listing_moderated", {
    adminId: user.id,
    listingId: id,
    status: data!.status,
    reportsCleared: cleared,
  });
  await auditAdmin(repo, {
    adminId: user.id,
    event: "listing_moderated",
    targetType: "listing",
    targetId: id,
    meta: { status: data!.status, reportsCleared: cleared },
  });
  return ok(await repo.getListing(id));
}
