import { clientIp, err, ok, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { auditAdmin } from "@/lib/audit";
import { notifyDealReverted } from "@/lib/notify";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";
import { analyticsProvider } from "@jetmarket/providers";

// Admin reverts a deal whose sale fell through (QA-550): the success-fee
// invoice is voided (pending/invoiced — a paid one means money moved and
// must be refunded outside the app first) and the one-off listing the deal
// consumed returns to 'active'. The RFQ stays closed — reverting undoes the
// marketplace's fee claim and frees the inventory; resurrecting the demand
// is the buyer's own call (QA-540 reopen). Idempotent: an already-void row
// skips the CAS and still reaches the restore, so a re-run after a partial
// failure finishes the job.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);
  if (!rateLimit(`admin-deal-revert:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const { id } = await params;
  const repo = await getRepo();
  const deal = await repo.getDeal(id);
  if (!deal) return err("deal not found", 404);
  // Per-vertical boundary via quote → rfq (QA-296).
  const quote = await repo.getQuote(deal.quoteId);
  const rfq = quote ? await repo.getRfq(quote.rfqId) : undefined;
  if (!quote || !rfq || rfq.vertical !== verticalSlug()) {
    return err("deal not found", 404);
  }
  if (deal.invoiceStatus === "paid") {
    return err(
      "invoice is paid — refund it outside the app before reverting",
      409,
    );
  }
  if (
    deal.invoiceStatus !== "void" &&
    !(await repo.setDealInvoice(id, "void", undefined, [
      "pending",
      "invoiced",
    ]))
  ) {
    const cur = (await repo.getDeal(id))?.invoiceStatus ?? "gone";
    return err(`invoice is ${cur} — only pending/invoiced can be voided`, 409);
  }

  // Restore only the inventory THIS deal consumed: the RFQ's pinned listing,
  // owned by the winning operator, sitting 'sold' — only its closing deal
  // can have flipped it (QA-502's consume condition, mirrored). Capacity
  // types never left the market and another operator's stock wasn't eaten,
  // so both are no-ops. No plan cap — the machine was always theirs; a
  // downgrade since doesn't forfeit it.
  const listing = rfq.listingId
    ? await repo.getListing(rfq.listingId)
    : undefined;
  let restoredListingId: string | undefined;
  if (
    listing &&
    listing.operatorId === quote.operatorId &&
    listing.status === "sold"
  ) {
    await repo.updateListingStatus(listing.id, "active");
    restoredListingId = listing.id;
  }

  await notifyDealReverted(repo, deal, quote, rfq, {
    restoredListingId,
    listingTitle: listing?.title,
  });
  analyticsProvider().track({
    name: "deal_reverted",
    props: { dealId: id, restoredListingId: restoredListingId ?? null },
  });
  logInfo("admin.deal_reverted", {
    adminId: user.id,
    dealId: id,
    was: deal.invoiceStatus,
    restoredListingId,
  });
  await auditAdmin(repo, {
    adminId: user.id,
    event: "deal_reverted",
    targetType: "deal",
    targetId: id,
    meta: { was: deal.invoiceStatus, restoredListingId },
  });
  return ok({ deal: await repo.getDeal(id), restoredListingId });
}
