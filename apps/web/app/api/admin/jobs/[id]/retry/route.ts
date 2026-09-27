import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  const { id } = await params;
  const repo = await getRepo();
  if (!(await repo.retryJob(id))) {
    return err("job not found or not failed", 409);
  }
  return ok({ requeued: true });
}
