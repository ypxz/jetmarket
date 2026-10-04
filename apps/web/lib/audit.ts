import { logWarn } from "@/lib/log";
import { verticalSlug } from "@/lib/vertical";
import type { Repo } from "@/lib/repo/types";

/**
 * QA-467: append an admin enforcement write to the audit trail — non-fatal
 * like lib/notify.ts: a failed audit write never fails the moderation
 * action that just landed.
 */
export async function auditAdmin(
  repo: Repo,
  e: {
    adminId: string;
    event: string;
    targetType: string;
    targetId: string;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await repo.logAdminEvent({ ...e, vertical: verticalSlug() });
  } catch (err) {
    logWarn("audit.write_failed", { err: String(err), event: e.event });
  }
}
