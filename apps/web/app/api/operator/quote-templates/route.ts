import { z } from "zod";
import { clientIp, err, noStore, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

const TemplateBody = z.object({
  name: z.string().trim().min(1).max(80),
  amount: z.number().positive().max(1e9),
  message: z.string().max(2000).optional().default(""),
});

/**
 * GET — the caller's saved quote templates (QA-527). The inbox quote form
 * fetches these on mount to offer one-click fill. Operator-private; no
 * other surface reads them.
 */
export async function GET() {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  const templates = await repo.listQuoteTemplates(operator.id);
  return noStore(ok({ templates }));
}

/**
 * POST — save (or replace) a template by name. `amount` is display units,
 * the same number the quote form takes; the quote's currency comes from
 * the listing at send time, so templates stay currency-agnostic.
 */
export async function POST(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("unauthorized", 401);
  if (!rateLimit(`quote-template:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { data, error } = await parseBody(req, TemplateBody);
  if (error) return error;
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);
  const template = await repo.upsertQuoteTemplate({
    operatorId: operator.id,
    name: data!.name,
    amount: data!.amount,
    message: data!.message ?? "",
  });
  return ok({ template }, 201);
}
