import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function GET(req: Request) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  const repo = await getRepo();
  // Optional ?limit/&offset= cap the payload; default is one page (QA-67).
  const url = new URL(req.url);
  const lim = Number(url.searchParams.get("limit"));
  const off = Number(url.searchParams.get("offset"));
  const ops = await repo.listOperators({
    limit: Number.isInteger(lim) && lim >= 1 ? Math.min(lim, 200) : 50,
    offset: Number.isInteger(off) && off >= 0 ? off : 0,
  });
  // Batched: one users lookup + one grouped listings count for the page —
  // was 2 queries per operator row (QA-103).
  const [userRows, listingCounts] = await Promise.all([
    repo.listUsers(ops.map((o) => o.userId)),
    repo.listListingCountsByOperator(ops.map((o) => o.id)),
  ]);
  const userById = new Map(userRows.map((u) => [u.id, u] as const));
  return ok(
    ops.map((o) => ({
      ...o,
      user: userById.get(o.userId) ?? null,
      listings: listingCounts[o.id] ?? 0,
    })),
  );
}
