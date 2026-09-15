import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function GET() {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  const repo = getRepo();
  return ok(
    repo.listOperators().map((o) => ({
      ...o,
      user: repo.getUser(o.userId) ?? null,
      listings: repo.countOperatorListings(o.id),
    })),
  );
}
