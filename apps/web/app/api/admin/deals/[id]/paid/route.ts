import { err, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

// TODO(T27): minimal mark-paid route — full invoice lifecycle lands with W2.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser("admin");
  if (!user) return err("admin only", 403);

  const { id } = await params;
  const repo = await getRepo();
  const deal = (await repo.listDeals()).find((d) => d.id === id);
  if (!deal) return err("deal not found", 404);
  if (deal.invoiceStatus !== "invoiced") {
    return err(`invoice is ${deal.invoiceStatus}, not invoiced`, 409);
  }

  await repo.setDealInvoice(id, "paid", deal.invoiceRef);
  return ok({ deal: (await repo.listDeals()).find((d) => d.id === id) });
}
