import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { auditAdmin } from "@/lib/audit";
import { notifyDealInvoiceVoided } from "@/lib/notify";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

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
  // Per-vertical boundary via quote → rfq (QA-296).
  const quote = await repo.getQuote(deal.quoteId);
  const rfq = quote ? await repo.getRfq(quote.rfqId) : undefined;
  if (rfq && rfq.vertical !== verticalSlug())
    return err("deal not found", 404);
  // CAS: never void an invoice that raced to paid in between (QA-145).
  if (
    !(await repo.setDealInvoice(id, "void", undefined, [
      "pending",
      "invoiced",
    ]))
  ) {
    const cur = (await repo.getDeal(id))?.invoiceStatus ?? "gone";
    return err(`invoice is ${cur} — only pending/invoiced can be voided`, 409);
  }
  // Owner told — symmetric with the paid notification (QA-249). Non-fatal.
  await notifyDealInvoiceVoided(repo, deal);
  logInfo("admin.deal_invoice_voided", {
    adminId: user.id,
    dealId: id,
    was: deal.invoiceStatus,
  });
  await auditAdmin(repo, {
    adminId: user.id,
    event: "deal_invoice_voided",
    targetType: "deal",
    targetId: id,
    meta: { was: deal.invoiceStatus },
  });
  return ok(await repo.getDeal(id));
}
