import type { Deal } from "@/lib/repo/types";

/** QA-489: accounting export — the /app ledger paginates so an operator
 *  closing their books has no full pull. One row per deal, RFC 4180
 *  quoting (comma/quote/newline cells get wrapped and " doubles). */

export const DEALS_CSV_HEADER =
  "closed_at,listing,amount,currency,fee_amount,fee_pct,invoice_status,invoice_ref,buyer_email,buyer_rating";

function cell(v: string | number | undefined): string {
  const s = v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function dealsToCsv(deals: Deal[]): string {
  const rows = deals.map((d) =>
    [
      cell(d.closedAt),
      cell(d.listingTitle),
      cell(d.amount),
      cell(d.currency),
      cell(d.feeAmount),
      cell(d.feePct),
      cell(d.invoiceStatus),
      cell(d.invoiceRef),
      cell(d.buyerEmail),
      cell(d.buyerRating),
    ].join(","),
  );
  return [DEALS_CSV_HEADER, ...rows].join("\n") + "\n";
}
