import { clientIp, err, noStore, ok, rateLimit } from "@/lib/api";
import { currentUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

// QA-542: session-side mute that keeps the row — same dual mailbox proof
// as /off (signed-in session owning the alert's email, or a live RFQ
// bearer token for it). 'active' → 'paused' CAS; anything else 409s.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!rateLimit(`search-alert-pause:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { id } = await params;
  const url = new URL(req.url);
  const user = await currentUser();
  const email = user?.email ?? url.searchParams.get("email");
  const token =
    req.headers.get("x-rfq-token") ?? url.searchParams.get("t");
  if (!email) return err("email required", 400);
  if (!user && !token) return err("use the link from your email", 401);
  const repo = await getRepo();
  const vertical = verticalSlug();
  if (!user) {
    const owns = (
      await repo.listRfqs({
        buyerEmail: email,
        vertical,
        limit: 200,
      })
    ).some((r) => r.accessToken === token);
    if (!owns) return err("use the link from your email", 401);
  }
  const alert = (await repo.listSearchAlerts({ vertical, email })).find(
    (a) => a.id === id,
  );
  if (!alert) return err("saved search not found", 404);
  const flipped = await repo.setSearchAlertStatus(alert.id, "paused", [
    "active",
  ]);
  if (!flipped) return err("saved search is not active", 409);
  return noStore(ok({ ok: true, status: flipped.status }));
}
