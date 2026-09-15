import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const repo = getRepo();
  const listing = repo.getListing(id);
  if (!listing || listing.status !== "active") return err("not found", 404);
  return ok({ ...listing, operator: repo.getOperator(listing.operatorId) ?? null });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  const repo = getRepo();
  const listing = repo.getListing(id);
  const operator = repo.getOperatorByUserId(user.id);
  if (!listing || !operator || listing.operatorId !== operator.id) {
    return err("not found", 404);
  }
  const body = (await req.json().catch(() => ({}))) as { status?: string };
  if (body.status && ["draft", "active", "paused", "archived"].includes(body.status)) {
    repo.updateListingStatus(id, body.status as typeof listing.status);
  }
  return ok(repo.getListing(id));
}
