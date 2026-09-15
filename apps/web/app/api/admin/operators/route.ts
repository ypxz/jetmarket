import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function GET() {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  const repo = await getRepo();
  const ops = await repo.listOperators();
  return ok(
    await Promise.all(
      ops.map(async (o) => ({
        ...o,
        user: (await repo.getUser(o.userId)) ?? null,
        listings: await repo.countOperatorListings(o.id),
      })),
    ),
  );
}
