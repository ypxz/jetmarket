import { clientIp, err, rateLimit } from "@/lib/api";
import { currentUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

// QA-547: operator-side portability export — the QA-544 counterpart for the
// selling side. Session-only: operators always have accounts (their profile
// IS the account), so there is no bearer path — a signed-in buyer or
// stranger without an operator row gets 404, anonymous gets 401.
export async function GET(req: Request) {
  if (!rateLimit(`operator-export:${clientIp(req)}`, 10, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const user = await currentUser();
  if (!user) return err("sign in first", 401);
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("no operator profile", 404);
  const data = await repo.exportOperatorData(operator.id);
  if (!data) return err("no operator profile", 404);
  const day = data.exportedAt.slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="jetmarket-operator-export-${day}.json"`,
      "cache-control": "private, no-store",
    },
  });
}
