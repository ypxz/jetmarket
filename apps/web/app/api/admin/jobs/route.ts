import { z } from "zod";
import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

const Status = z.enum(["pending", "running", "done", "failed"]);

export async function GET(req: Request) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  const url = new URL(req.url);
  const lim = Number(url.searchParams.get("limit"));
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? Status.safeParse(statusParam) : null;
  if (status && !status.success) return err("unknown status", 400);
  const repo = await getRepo();
  const jobs = await repo.listJobs({
    ...(status?.success ? { status: status.data } : {}),
    limit: Number.isInteger(lim) && lim >= 1 ? Math.min(lim, 200) : 50,
  });
  return ok(jobs);
}
