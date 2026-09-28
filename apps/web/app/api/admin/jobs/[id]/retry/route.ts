import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (!rateLimit(`admin-job-retry:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { id } = await params;
  const repo = await getRepo();
  // Per-vertical boundary: another deploy's failed job is not ours to
  // requeue (QA-296).
  if (!(await repo.retryJob(id, verticalSlug()))) {
    return err("job not found or not failed", 409);
  }
  return ok({ requeued: true });
}
