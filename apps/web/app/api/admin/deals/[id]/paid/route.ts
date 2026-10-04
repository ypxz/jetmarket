import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo, logWarn } from "@/lib/log";
import { auditAdmin } from "@/lib/audit";
import { site } from "@jetmarket/config";
import { brandedEmailHtml, emailProvider } from "@jetmarket/providers";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";
import { mailCopy, mailT } from "@jetmarket/i18n";

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
  // Per-vertical boundary — a shared DB hosts every vertical's deals;
  // resolve the deal's vertical through quote → rfq (QA-296).
  const quote = await repo.getQuote(deal.quoteId);
  const rfq = quote ? await repo.getRfq(quote.rfqId) : undefined;
  if (rfq && rfq.vertical !== verticalSlug())
    return err("deal not found", 404);
  // CAS: a concurrent void must not be overwritten back to paid (QA-145).
  if (!(await repo.setDealInvoice(id, "paid", undefined, ["invoiced"]))) {
    const cur = (await repo.getDeal(id))?.invoiceStatus ?? "gone";
    return err(`invoice is ${cur}, not invoiced`, 409);
  }
  logInfo("admin.deal_invoice_paid", { adminId: user.id, dealId: id });
  await auditAdmin(repo, {
    adminId: user.id,
    event: "deal_invoice_paid",
    targetType: "deal",
    targetId: id,
  });
  // Close the loop: the operator should learn their success-fee invoice
  // settled without watching the dashboard. Mail failure must not 500 —
  // the ledger state already flipped.
  try {
    const operator = await repo.getOperator(deal.operatorId);
    const owner = operator ? await repo.getUser(operator.userId) : undefined;
    if (owner) {
      const m = await mailCopy(owner.locale);
      const subject = mailT(m, "invoicePaid.subject", {
        id: id.slice(0, 8),
      });
      const body = mailT(m, "invoicePaid.body", {
        refParen: deal.invoiceRef
          ? mailT(m, "shared.refParen", { ref: deal.invoiceRef })
          : "",
        currency: deal.currency,
        fee: deal.feeAmount,
        amount: deal.amount,
      });
      await emailProvider().send({
        to: owner.email,
        subject,
        text: body,
        html: brandedEmailHtml({
          siteName: site.name,
          title: subject,
          paragraphs: [body],
        }),
      });
    }
  } catch (e) {
    logWarn("admin.deal_paid_email_failed", {
      dealId: id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return ok(await repo.getDeal(id));
}
