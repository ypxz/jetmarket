import { clientIp, err, rateLimit } from "@/lib/api";
import { currentUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

// QA-544: GDPR-style portability export — the read-only counterpart of
// /api/account/delete (QA-543). Same two proofs of mailbox ownership: a
// signed-in session (no params), or `?email=` + a live RFQ bearer token
// (`?t=` or the x-rfq-token header) for emailed-links buyers. GET because
// it's a pure download — a link in mail or on /account can point straight
// at it; `download` + Content-Disposition makes the browser save the JSON.
export async function GET(req: Request) {
  if (!rateLimit(`account-export:${clientIp(req)}`, 10, 60 * 60 * 1000)) {
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
  const data = await repo.exportBuyerData(email, vertical);
  const day = data.exportedAt.slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="jetmarket-export-${day}.json"`,
      // A mailbox's whole record must never sit in a shared cache.
      "cache-control": "private, no-store",
    },
  });
}
