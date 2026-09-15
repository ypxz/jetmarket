import { z } from "zod";
import { err, ok, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

const UpsertOperator = z.object({
  name: z.string().min(2).max(120),
  baseAirport: z.string().min(3).max(8),
  fleetSummary: z.string().max(500).default(""),
});

export async function POST(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("sign in as an operator first", 401);
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
  return ok(operator, prev ? 200 : 201);
}

export async function GET() {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  return ok((await getRepo()).getOperatorByUserId(user.id) ?? null);
}
