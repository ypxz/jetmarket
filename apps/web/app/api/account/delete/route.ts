import { clientIp, err, noStore, ok, rateLimit } from "@/lib/api";
import { currentUser, sessionCookie } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

// QA-543: GDPR-style self-delete. Two proofs of mailbox ownership, same as
// the search-alert /off|pause|resume family — a signed-in session whose
// email is being deleted (the /account danger-zone button), or possession
// of any live RFQ bearer token for the mailbox (the emailed-links path for
// buyers who never made an account). The sweep itself lives in
// `repo.deleteBuyerData` — one transaction tombstones the mailbox out of
// every buyer-side surface.
export async function POST(req: Request) {
  if (!rateLimit(`account-delete:${clientIp(req)}`, 10, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const url = new URL(req.url);
  const user = await currentUser();
  const email = (user?.email ?? url.searchParams.get("email"))?.toLowerCase();
  const token = req.headers.get("x-rfq-token") ?? url.searchParams.get("t");
  if (!email) return err("email required", 400);
  if (!user && !token) return err("use the link from your email", 401);
  const repo = await getRepo();
  const vertical = verticalSlug();
  if (!user) {
    const owns = (
      await repo.listRfqs({ buyerEmail: email, vertical, limit: 200 })
    ).some((r) => r.accessToken === token);
    if (!owns) return err("use the link from your email", 401);
  }
  const result = await repo.deleteBuyerData(email, vertical);
  const res = noStore(ok({ ok: true, ...result }));
  // A deleted users row kills every session cookie anyway; clear this one
  // eagerly so the next render isn't briefly an orphaned session lookup.
  if (user) {
    res.cookies.set(sessionCookie, "", {
      httpOnly: true,
      path: "/",
      maxAge: 0,
    });
  }
  return res;
}
