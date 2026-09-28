import { clientIp, err, noStore, ok, rateLimit } from "@/lib/api";
import { currentUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function GET(req: Request) {
  if (!rateLimit(`auth-me:${clientIp(req)}`, 600, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const user = await currentUser();
  const operator = user ? (await getRepo()).getOperatorByUserId(user.id) : undefined;
  return noStore(ok({ user, operator }));
}
