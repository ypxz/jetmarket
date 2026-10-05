import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { auditAdmin } from "@/lib/audit";
import { appOrigin } from "@/lib/origin";
import { getRepo } from "@/lib/repo";
import {
  flushSearchAlertBacklog,
  searchAlertSignature,
} from "@/lib/search-alerts";
import { verticalSlug } from "@/lib/vertical";

const FlushBody = z.object({
  /** The canonical demand signature the row renders ("" / "(any)" for the
   *  no-filter group). Re-derived server-side — ids are never trusted. */
  signature: z.string().max(500),
});

/**
 * Admin demand-flush (QA-564): the radar shows digest backlog per demand
 * signature — this sends those queued digests immediately instead of
 * waiting for the worker's matured-window pass (a hot demand the admin
 * just seeded inventory for shouldn't sit in a 20h cooldown). The group
 * is re-derived via searchAlertSignature so a crafted signature can only
 * ever match its own alerts; only alerts with a non-empty backlog flush.
 */
export async function POST(req: Request) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (
    !rateLimit(`admin-alert-flush:${clientIp(req)}`, 30, 60 * 60 * 1000)
  ) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, FlushBody);
  if (error) return error;

  const repo = await getRepo();
  const alerts = await repo.listSearchAlerts({
    vertical: verticalSlug(),
    status: "active",
  });
  const key = data!.signature || "(any)";
  const group = alerts.filter(
    (a) => (searchAlertSignature(a.params) || "(any)") === key,
  );
  const origin = appOrigin(req);
  let sent = 0;
  let cleared = 0;
  let failed = 0;
  for (const alert of group) {
    if (!alert.pendingIds.length) continue;
    const result = await flushSearchAlertBacklog(repo, alert, origin);
    if (result === "sent") sent += 1;
    else if (result === "cleared") cleared += 1;
    else failed += 1;
  }
  if (!sent && !cleared && !failed) {
    return err("no pending backlog in this demand group", 409);
  }
  logInfo("admin.search_alert_flush", {
    adminId: user.id,
    signature: key,
    sent,
    cleared,
    failed,
  });
  await auditAdmin(repo, {
    adminId: user.id,
    event: "search_alert_flush",
    targetType: "search_alert",
    targetId: key.slice(0, 200),
    meta: { sent, cleared, failed },
  });
  return ok({ sent, cleared, failed });
}
