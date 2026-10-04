import { clientIp, err, noStore, ok, rateLimit } from "@/lib/api";
import { currentUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { searchAlertSummary } from "@/lib/search-alerts";
import { verticalSlug } from "@/lib/vertical";

// Buyer self-service for saved searches (QA-405): the same gate as
// /api/buyer/quotes — possession of any live RFQ's bearer token for this
// mailbox proves inbox access, so it lists that mailbox's alerts; QA-474
// adds the session arm (a signed-in buyer's own email, param ignored).
// Tokens never appear in the response: rows are addressed by id for the
// session-authed `POST /api/search-alerts/[id]/off` turn-off.
export async function GET(req: Request) {
  if (!rateLimit(`buyer-search-alerts:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const url = new URL(req.url);
  const user = await currentUser();
  const email = url.searchParams.get("email") ?? user?.email ?? null;
  const sessionOwns =
    !!user && !!email && user.email.toLowerCase() === email.toLowerCase();
  const token =
    req.headers.get("x-rfq-token") ?? url.searchParams.get("t");
  if (!email) return err("email required", 400);
  if (!sessionOwns && !token) return err("use the link from your email", 401);
  const repo = await getRepo();
  if (!sessionOwns) {
    const owns = (
      await repo.listRfqs({ buyerEmail: email, vertical: verticalSlug(), limit: 200 })
    ).some((r) => r.accessToken === token);
    if (!owns) return err("use the link from your email", 401);
  }
  const alerts = await repo.listSearchAlerts({
    vertical: verticalSlug(),
    email,
  });
  return noStore(
    ok(
      alerts.map((a) => ({
        id: a.id,
        params: a.params,
        // Labeled recap (QA-409) — the client falls back to raw k=v pairs
        // when this is empty (e.g. a watch row, which gets its own label).
        summary: searchAlertSummary(a.params),
        status: a.status,
        freq: a.freq,
        createdAt: a.createdAt,
      })),
    ),
  );
}
