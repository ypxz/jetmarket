import { z } from "zod";
import { analyticsProvider } from "@jetmarket/providers";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { logInfo } from "@/lib/log";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";
import { buyerAuthorized } from "@/lib/buyer-auth";

const PauseRfq = z.object({
  buyerEmail: z.string().email().max(254),
  token: z.string().max(256).optional().default(""),
  paused: z.boolean(),
});

/** Buyer-initiated pause/resume (QA-533): freezing NEW offer intake when
 *  enough offers have landed to compare, then re-opening. Existing quotes
 *  stay acceptable/declinable and the request keeps its natural deadline —
 *  pause is an intake gate, not a status, so resume needs no derivation.
 *  The CAS refuses a pause on a terminal row or a double-toggle in either
 *  direction. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!rateLimit(`rfq-pause:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, PauseRfq);
  if (error) return error;
  const { id } = await params;
  const repo = await getRepo();
  const rfq = await repo.getRfq(id);
  if (
    !rfq ||
    rfq.vertical !== verticalSlug() ||
    !(await buyerAuthorized(rfq, data!))
  ) {
    return err("not found", 404);
  }
  if (!(await repo.setRfqPaused(id, data!.paused))) {
    return err(
      data!.paused
        ? "rfq is no longer open or already paused"
        : "rfq is not paused",
      409,
    );
  }
  logInfo("rfq.paused_toggled", { rfqId: rfq.id, paused: data!.paused });
  analyticsProvider().track({
    name: "rfq_paused_toggled",
    props: { rfqId: rfq.id, paused: data!.paused },
  });
  return ok({ id: rfq.id, paused: data!.paused });
}
