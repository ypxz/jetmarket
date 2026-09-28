import { z } from "zod";
import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

const Status = z.enum(["pending", "running", "done", "failed"]);

export async function GET(req: Request) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (!rateLimit(`admin-jobs:${clientIp(req)}`, 600, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const url = new URL(req.url);
  const lim = Number(url.searchParams.get("limit"));
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? Status.safeParse(statusParam) : null;
  if (status && !status.success) return err("unknown status", 400);
  const repo = await getRepo();
  const jobs = await repo.listJobs({
    ...(status?.success ? { status: status.data } : {}),
    // Shared-DB queues are per-vertical; NULL jobs stay visible (QA-296).
    vertical: verticalSlug(),
    limit: Number.isInteger(lim) && lim >= 1 ? Math.min(lim, 200) : 50,
  });
  return ok(jobs);
}
