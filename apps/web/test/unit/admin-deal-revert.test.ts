/**
 * QA-550 admin deal revert (POST /api/admin/deals/[id]/revert): voids the
 * success-fee invoice and returns the consumed one-off listing to 'active'.
 * Paid invoices refuse (money moved — refund outside first), capacity-type
 * deals restore nothing, another operator's sold listing isn't touched,
 * foreign-vertical deals 404, non-admins 403. Idempotent — an already-void
 * deal still reaches the restore, so a re-run after a partial failure
 * finishes the job. Both parties get a mail.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_OUTBOX_DIR = mkdtempSync(join(tmpdir(), "jm-outbox-"));

import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { value: jar.get(name) } : undefined,
  }),
}));

import { email } from "@jetmarket/providers";
import { sessionCookie, signSession } from "../../lib/auth";
import { getMemoryRepo } from "../../lib/repo/memory";
import type { Listing, Repo, Rfq } from "../../lib/repo/types";
import { POST as acceptQuote } from "../../app/api/quotes/[id]/accept/route";
import { POST as revertDeal } from "../../app/api/admin/deals/[id]/revert/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) =>
  new Request("http://test.local/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
const asUser = (id: string | null, sessionVersion = 1) =>
  id
    ? jar.set(sessionCookie, signSession(id, sessionVersion))
    : jar.delete(sessionCookie);

let repo: Repo;

beforeEach(async () => {
  jar.clear();
  repo = await getMemoryRepo();
});

async function fixture(listingType: string, vertical = "jets") {
  const tag = Math.random().toString(36).slice(2, 8);
  const opUser = await repo.createUser(`op-${tag}@test.dev`, "operator");
  const op = await repo.upsertOperator({
    userId: opUser.id,
    name: `Ops ${tag}`,
    baseAirport: "ZRH",
    fleetSummary: "",
    verified: true,
    plan: "pro",
  });
  const listing = await repo.createListing({
    operatorId: op.id,
    vertical,
    type: listingType,
    title: `Sale jet ${tag}`,
    price: 9000,
    currency: "USD",
    photos: [],
    attributes: {},
  });
  await repo.updateListingStatus(listing.id, "active");
  const buyerEmail = `buyer-${tag}@test.dev`;
  const rfq = await repo.createRfq({
    vertical,
    listingId: listing.id,
    buyerEmail,
    fields: {},
  });
  const quote = await repo.createQuote({
    rfqId: rfq.id,
    operatorId: op.id,
    amount: 9000,
    currency: "USD",
    message: "",
  });
  return { opUser, op, listing, rfq, quote, buyerEmail };
}

/** Close a deal over the real accept route (mints the deal + consumes the
 *  one-off listing when the type says so). */
async function closeDeal(rfq: Rfq, quoteId: string, buyerEmail: string) {
  const acc = await acceptQuote(
    post({ buyerEmail, token: rfq.accessToken }),
    params(quoteId),
  );
  expect(acc.status).toBe(200);
  const { deal } = (await acc.json()) as {
    deal: { id: string; invoiceStatus: string; invoiceRef?: string };
  };
  return deal;
}

const adminUser = async () =>
  repo.createUser(`admin-${Math.random().toString(36).slice(2, 8)}@test.dev`, "admin");

const status = async (listing: Listing) =>
  (await repo.getListing(listing.id))?.status;

describe("POST /api/admin/deals/[id]/revert (QA-550)", () => {
  it("voids the invoice and restores the consumed one-off listing; idempotent", async () => {
    const { opUser, listing, rfq, quote, buyerEmail } = await fixture("aircraft_sale");
    const deal = await closeDeal(rfq, quote.id, buyerEmail);
    expect(await status(listing)).toBe("sold");

    const admin = await adminUser();
    asUser(admin.id);
    const res = await revertDeal(post(), params(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deal: { invoiceStatus: string };
      restoredListingId?: string;
    };
    expect(body.deal.invoiceStatus).toBe("void");
    expect(body.restoredListingId).toBe(listing.id);
    expect(await status(listing)).toBe("active");

    // Both parties were mailed.
    const mails = email
      .readOutbox(process.env.EMAIL_OUTBOX_DIR)
      .filter((m) =>
        ["reverted", "fell through"].some((s) => m.subject.includes(s)),
      );
    const opMail = mails.find((m) => m.to === opUser.email);
    const buyerMail = mails.find((m) => m.to === buyerEmail);
    expect(opMail?.subject).toContain("reverted");
    expect(opMail?.text).toContain("back on the market");
    expect(buyerMail?.subject).toContain("fell through");

    // Re-run on the already-void row: 200, no double-restore bookkeeping.
    const again = await revertDeal(post(), params(deal.id));
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as {
      restoredListingId?: string;
    };
    expect(againBody.restoredListingId).toBeUndefined();
    expect(await status(listing)).toBe("active");
  });

  it("resumes a partial revert: already-void invoice still restores the listing", async () => {
    const { listing, rfq, quote, buyerEmail } = await fixture("empty_leg");
    const deal = await closeDeal(rfq, quote.id, buyerEmail);
    expect(await status(listing)).toBe("sold");
    // Simulate a crashed earlier run: invoice voided, listing never freed.
    await repo.setDealInvoice(deal.id, "void", deal.invoiceRef, [
      "pending",
      "invoiced",
    ]);

    const admin = await adminUser();
    asUser(admin.id);
    const res = await revertDeal(post(), params(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restoredListingId?: string };
    expect(body.restoredListingId).toBe(listing.id);
    expect(await status(listing)).toBe("active");
  });

  it("paid invoices refuse — money moved, refund outside the app first", async () => {
    const { listing, rfq, quote, buyerEmail } = await fixture("aircraft_sale");
    const deal = await closeDeal(rfq, quote.id, buyerEmail);
    await repo.setDealInvoice(deal.id, "paid", deal.invoiceRef, [
      "pending",
      "invoiced",
    ]);

    const admin = await adminUser();
    asUser(admin.id);
    const res = await revertDeal(post(), params(deal.id));
    expect(res.status).toBe(409);
    expect(await status(listing)).toBe("sold");
    expect((await repo.getDeal(deal.id))?.invoiceStatus).toBe("paid");
  });

  it("capacity-type deals (charter) restore nothing — the listing never left", async () => {
    const { listing, rfq, quote, buyerEmail } = await fixture("charter");
    const deal = await closeDeal(rfq, quote.id, buyerEmail);
    expect(await status(listing)).toBe("active"); // capacity, not consumed

    const admin = await adminUser();
    asUser(admin.id);
    const res = await revertDeal(post(), params(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deal: { invoiceStatus: string };
      restoredListingId?: string;
    };
    expect(body.deal.invoiceStatus).toBe("void");
    expect(body.restoredListingId).toBeUndefined();
    expect(await status(listing)).toBe("active");
  });

  it("does not restore another operator's sold listing", async () => {
    // The RFQ pinned op A's listing but op B's quote won (QA-502): A's row
    // was never consumed by this deal — revert must leave it alone.
    const { listing, rfq, buyerEmail } = await fixture("aircraft_sale");
    const otherUser = await repo.createUser(
      `other-${Math.random().toString(36).slice(2, 8)}@test.dev`,
      "operator",
    );
    const otherOp = await repo.upsertOperator({
      userId: otherUser.id,
      name: "Other",
      baseAirport: "GVA",
      fleetSummary: "",
      verified: true,
      plan: "pro",
    });
    const winner = await repo.createQuote({
      rfqId: rfq.id,
      operatorId: otherOp.id,
      amount: 9500,
      currency: "USD",
      message: "",
    });
    const deal = await closeDeal(rfq, winner.id, buyerEmail);
    expect(await status(listing)).toBe("active"); // winner ≠ owner → unsold

    // Force op A's listing sold through an unrelated sale (the row is
    // legitimately gone — revert of B's deal must NOT resurrect it).
    await repo.updateListingStatus(listing.id, "sold");

    const admin = await adminUser();
    asUser(admin.id);
    const res = await revertDeal(post(), params(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restoredListingId?: string };
    expect(body.restoredListingId).toBeUndefined();
    expect(await status(listing)).toBe("sold");
  });

  it("foreign-vertical deal 404s; non-admin 403s", async () => {
    const { listing, rfq, quote, buyerEmail } = await fixture("charter");
    const deal = await closeDeal(rfq, quote.id, buyerEmail);

    // Foreign deploy's row on the shared DB — the admin of THIS deploy
    // can't reach it (QA-296 boundary).
    const tag = Math.random().toString(36).slice(2, 8);
    const fUser = await repo.createUser(`fop-${tag}@test.dev`, "operator");
    const fOp = await repo.upsertOperator({
      userId: fUser.id,
      name: "Fop",
      baseAirport: "MXP",
      fleetSummary: "",
      verified: true,
      plan: "pro",
    });
    const fRfq = await repo.createRfq({
      vertical: "machinery",
      listingId: null,
      buyerEmail: `f-${tag}@test.dev`,
      fields: {},
    });
    const fQuote = await repo.createQuote({
      rfqId: fRfq.id,
      operatorId: fOp.id,
      amount: 100,
      currency: "EUR",
      message: "",
    });
    const fDeal = await repo.createDeal({
      quoteId: fQuote.id,
      operatorId: fOp.id,
      amount: 100,
      currency: "EUR",
      feePct: 0.02,
      feeAmount: 2,
      invoiceStatus: "pending",
    });

    const admin = await adminUser();
    asUser(admin.id);
    expect((await revertDeal(post(), params(fDeal.id))).status).toBe(404);

    // Operator (not admin) → 403; anonymous → 403.
    const { opUser } = await fixture("charter");
    asUser(opUser.id);
    expect((await revertDeal(post(), params(deal.id))).status).toBe(403);
    asUser(null);
    expect((await revertDeal(post(), params(deal.id))).status).toBe(403);
    void listing;
  });
});
