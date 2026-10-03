import { clientIp, err, noStore, ok, rateLimit } from "@/lib/api";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

// Buyer UI turn-off (QA-405): /quotes renders the mailbox's alerts with a
// per-row "turn off" — same auth as GET /api/buyer/search-alerts (any live
// RFQ bearer token for the mailbox). The alert must belong to that email
// AND this vertical before the 'off' CAS runs (QA-293: scope before CAS).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!rateLimit(`search-alert-off:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { id } = await params;
  const url = new URL(req.url);
  const email = url.searchParams.get("email");
  const token =
    req.headers.get("x-rfq-token") ?? url.searchParams.get("t");
  if (!email) return err("email required", 400);
  if (!token) return err("use the link from your email", 401);
  const repo = await getRepo();
  const vertical = verticalSlug();
  const owns = (
    await repo.listRfqs({
      buyerEmail: email,
      vertical,
      limit: 200,
    })
  ).some((r) => r.accessToken === token);
  if (!owns) return err("use the link from your email", 401);
  const alert = (await repo.listSearchAlerts({ vertical, email })).find(
    (a) => a.id === id,
  );
  if (!alert) return err("saved search not found", 404);
  await repo.unsubscribeSearchAlert(alert.token);
  return noStore(ok({ ok: true }));
}
