import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { getRepo } from "@/lib/repo";

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
  if (!listing) return err("not found", 404);
  await repo.updateListingStatus(id, data!.status);
  logInfo("admin.listing_moderated", {
    adminId: user.id,
    listingId: id,
    status: data!.status,
  });
  return ok(await repo.getListing(id));
}
