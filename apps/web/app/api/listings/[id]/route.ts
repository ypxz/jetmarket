import { z } from "zod";
import { err, ok, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

const PatchListing = z.object({
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const repo = await getRepo();
  const listing = await repo.getListing(id);
  if (!listing || listing.status !== "active") return err("not found", 404);
  return ok({ ...listing, operator: await repo.getOperator(listing.operatorId) ?? null });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  const repo = await getRepo();
  const listing = await repo.getListing(id);
  const operator = await repo.getOperatorByUserId(user.id);
  if (!listing || !operator || listing.operatorId !== operator.id) {
    return err("not found", 404);
  }
  const { data, error } = await parseBody(req, PatchListing);
  if (error) return error;
  if (data!.status) {
    await repo.updateListingStatus(id, data!.status);
  }
  return ok(await repo.getListing(id));
}
