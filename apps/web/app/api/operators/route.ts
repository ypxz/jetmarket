import { z } from "zod";
import { clientIp, err, noStore, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

const UpsertOperator = z.object({
  name: z.string().min(2).max(120),
  baseAirport: z.string().min(3).max(60),
  fleetSummary: z.string().max(500).default(""),
});

export async function POST(req: Request) {
  // Any signed-in user may create an operator profile — a buyer-role account is
  // promoted to operator on first creation (the sign-in role radio only sets
  // the role at account creation, so existing buyers would otherwise be locked
  // out of onboarding forever).
  const user = await requireUser();
  if (!user) return err("sign in first", 401);
  if (!rateLimit(`operator-upsert:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, UpsertOperator);
  if (error) return error;
  const repo = await getRepo();
  const prev = await repo.getOperatorByUserId(user.id);
  const operator = await repo.upsertOperator({
    ...(prev ? { id: prev.id } : {}),
    userId: user.id,
    verified: prev?.verified ?? false,
    plan: prev?.plan ?? "free",
    name: data!.name,
    baseAirport: data!.baseAirport,
    fleetSummary: data!.fleetSummary ?? "",
  });
  if (!prev && user.role === "buyer") {
    await repo.setUserRole(user.id, "operator");
  }
  return noStore(ok(operator, prev ? 200 : 201));
}

export async function GET() {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  // The row must be awaited — NextResponse.json(Promise) serializes to {}
  // (truthy), which told profile-less users they already had one (QA-312).
  // Operator row carries plan/verified — private, never cache (QA-305).
  return noStore(
    ok((await (await getRepo()).getOperatorByUserId(user.id)) ?? null),
  );
}
