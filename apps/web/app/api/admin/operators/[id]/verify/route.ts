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
  const op = await repo.getOperator(id);
  if (!op) return err("not found", 404);
  await repo.setOperatorVerified(id, !op.verified);
  return ok(await repo.getOperator(id));
}
