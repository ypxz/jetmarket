import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { getRepo } from "@/lib/repo";

// Admin marks a success-fee invoice paid (mock ledger settlement).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (!rateLimit(`admin-deal-paid:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { id } = await params;
  const repo = await getRepo();
  const deal = await repo.getDeal(id);
  if (!deal) return err("deal not found", 404);
  if (deal.invoiceStatus !== "invoiced") {
    return err(`invoice is ${deal.invoiceStatus}, not invoiced`, 409);
  }
  // ref omitted on purpose — keeps the provider's invoice ref.
  await repo.setDealInvoice(id, "paid");
  logInfo("admin.deal_invoice_paid", { adminId: user.id, dealId: id });
  return ok(await repo.getDeal(id));
}
