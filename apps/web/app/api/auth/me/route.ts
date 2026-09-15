import { ok } from "@/lib/api";
import { currentUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function GET() {
  const user = await currentUser();
  const operator = user ? getRepo().getOperatorByUserId(user.id) : undefined;
  return ok({ user, operator });
}
