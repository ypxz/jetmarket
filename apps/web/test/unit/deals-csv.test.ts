import { describe, expect, it } from "vitest";
import { DEALS_CSV_HEADER, dealsToCsv } from "@/lib/deals-csv";
import type { Deal } from "@/lib/repo/types";

const base: Deal = {
  id: "d1",
  quoteId: "q1",
  operatorId: "o1",
  amount: 41000,
  currency: "USD",
  feePct: 5,
  feeAmount: 2050,
  invoiceStatus: "paid",
  invoiceRef: "inv_123",
  closedAt: "2026-10-04T10:00:00.000Z",
  buyerEmail: "buyer@x.com",
  buyerRating: 5,
  listingTitle: "LSZH Charter",
};

describe("dealsToCsv (QA-489)", () => {
  it("emits the header then one row per deal", () => {
    const csv = dealsToCsv([base]);
    const lines = csv.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(DEALS_CSV_HEADER);
    expect(lines[1]).toBe(
      "2026-10-04T10:00:00.000Z,LSZH Charter,41000,USD,2050,5,paid,inv_123,buyer@x.com,5",
    );
  });

  it("quotes cells containing comma/quote/newline — RFC 4180", () => {
    const csv = dealsToCsv([
      { ...base, listingTitle: 'Charter, "big" jet' },
      { ...base, buyerEmail: undefined, invoiceRef: undefined },
    ]);
    const lines = csv.trimEnd().split("\n");
    expect(lines[1]).toContain('"Charter, ""big"" jet"');
    expect(lines[2]).toContain(",,");
  });

  it("empty book is header-only", () => {
    expect(dealsToCsv([])).toBe(DEALS_CSV_HEADER + "\n");
  });
});
