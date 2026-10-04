import { z } from "zod";
import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

/**
 * Buyer report flag (QA-461) — feeds the admin queue that backs the
 * moderation/suspension tools. Reporting is the demand side flagging bad
 * supply, so it requires a buyer session: anonymous flags would be an
 * unauthenticated write sink and operator-on-operator flag wars add no
 * signal the admin can't already act on.
 */
const Report = z.object({
  reason: z.enum(["misleading", "unavailable", "scam", "other"]),
  note: z.string().max(500).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("buyer");
  if (!user) return err("forbidden", 403);
  if (!rateLimit(`listing-report:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const parsed = Report.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return err("invalid input", 400);
  const { id } = await params;
  const repo = await getRepo();
  const listing = await repo.getListing(id);
  // Any live-state listing is reportable; foreign-vertical rows 404 before
  // the write (shared-DB rule — a jets deploy must not queue machinery flags).
  if (!listing || listing.vertical !== verticalSlug()) {
    return err("not found", 404);
  }
  const report = await repo.createListingReport({
    listingId: id,
    reporterId: user.id,
    reason: parsed.data.reason,
    note: parsed.data.note,
  });
  if (!report) {
    // Idempotent re-flag — one open report per (listing, reporter).
    return err("already reported", 409);
  }
  // Deliberately silent toward the operator — an accusation mails nobody;
  // the admin acts through the moderation tools that DO notify (QA-461).
  logInfo("listing.reported", {
    listingId: id,
    reporterId: user.id,
    reason: report.reason,
  });
  return ok(report, 201);
}
