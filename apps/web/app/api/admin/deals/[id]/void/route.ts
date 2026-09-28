import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { getRepo } from "@/lib/repo";

// Admin voids a success-fee invoice (dispute/refund — keeps the row, kills the bill).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (!rateLimit(`admin-deal-void:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { id } = await params;
  const repo = await getRepo();
  const deal = await repo.getDeal(id);
  if (!deal) return err("deal not found", 404);
  if (deal.invoiceStatus !== "pending" && deal.invoiceStatus !== "invoiced") {
    return err(`invoice is ${deal.invoiceStatus} — only pending/invoiced can be voided`, 409);
  }
  await repo.setDealInvoice(id, "void");
  logInfo("admin.deal_invoice_voided", {
    adminId: user.id,
    dealId: id,
    was: deal.invoiceStatus,
  });
  return ok(await repo.getDeal(id));
}
