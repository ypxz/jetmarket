/**
 * Quote-lifecycle notification pins (QA-256): notifyQuoteDeclined mails the
 * quote's operator for all three reasons (declined / competing-accepted /
 * rfq-closed), and notifyBuyerQuoteWithdrawn mails the buyer — the only
 * channel that reaches an unauthenticated buyer.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_OUTBOX_DIR = mkdtempSync(join(tmpdir(), "jm-outbox-"));

import { describe, expect, it } from "vitest";

import { email } from "@jetmarket/providers";
import {
  notifyBuyerQuoteWithdrawn,
  notifyDealRated,
  notifyQuoteDeclined,
} from "../../lib/notify";
import { getMemoryRepo } from "../../lib/repo/memory";
import type { Repo } from "../../lib/repo/types";

async function fixture(repo: Repo, opLocale?: string) {
  const tag = Math.random().toString(36).slice(2, 8);
  const opUser = await repo.createUser(
    `op-${tag}@test.dev`,
    "operator",
    opLocale,
  );
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
    vertical: "jets",
    type: "charter",
    title: `Jet ${tag}`,
    price: 9000,
    currency: "USD",
    photos: [],
    attributes: {},
  });
  const rfq = await repo.createRfq({
    vertical: "jets",
    listingId: listing.id,
    buyerEmail: `buyer-${tag}@test.dev`,
    fields: {},
  });
  const quote = await repo.createQuote({
    rfqId: rfq.id,
    operatorId: op.id,
    amount: 9000,
    currency: "USD",
    message: "",
  });
  return { opUser, op, listing, rfq, quote };
}

describe("notifyQuoteDeclined", () => {
  it("mails the quote's operator for each reason", async () => {
    const repo = await getMemoryRepo();
    const { opUser, listing, rfq, quote } = await fixture(repo);
    const before = email.readOutbox(process.env.EMAIL_OUTBOX_DIR).length;

    for (const reason of [
      "declined",
      "competing-accepted",
      "rfq-closed",
    ] as const) {
      await notifyQuoteDeclined(repo, quote, rfq, reason);
    }
    const sent = email
      .readOutbox(process.env.EMAIL_OUTBOX_DIR)
      .slice(before)
      .filter((m) => m.to === opUser.email);
    expect(sent).toHaveLength(3);
    for (const m of sent) {
      expect(m.subject).toContain(listing.title);
      expect(m.text).toContain("USD 9000");
    }
    // outbox ids are timestamp+random — same-ms sends don't keep send order
    const subjects = sent.map((m) => m.subject);
    expect(subjects.some((s) => s.includes("declined"))).toBe(true);
    expect(subjects.some((s) => s.includes("another quote"))).toBe(true);
    expect(subjects.some((s) => s.includes("closed"))).toBe(true);
  });

  it("QA-494: renders in the operator's users.locale", async () => {
    const repo = await getMemoryRepo();
    const { opUser, listing, rfq, quote } = await fixture(repo, "de");
    const before = email.readOutbox(process.env.EMAIL_OUTBOX_DIR).length;

    await notifyQuoteDeclined(repo, quote, rfq, "declined");

    const sent = email
      .readOutbox(process.env.EMAIL_OUTBOX_DIR)
      .slice(before)
      .filter((m) => m.to === opUser.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe(
      `Ihr Angebot für „${listing.title}“ wurde abgelehnt`,
    );
    expect(sent[0]!.text).toContain("hat Ihr Angebot");
    expect(sent[0]!.text).toContain("USD 9000");
    expect(sent[0]!.text).not.toContain("was declined");
  });
});

describe("notifyBuyerQuoteWithdrawn", () => {
  it("mails the buyer (unauthenticated — email is the only channel)", async () => {
    const repo = await getMemoryRepo();
    const { listing, rfq, quote } = await fixture(repo);
    const before = email.readOutbox(process.env.EMAIL_OUTBOX_DIR).length;

    await notifyBuyerQuoteWithdrawn(repo, quote, rfq);

    const sent = email
      .readOutbox(process.env.EMAIL_OUTBOX_DIR)
      .slice(before)
      .filter((m) => m.to === rfq.buyerEmail);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("withdrawn");
    expect(sent[0]!.subject).toContain(listing.title);
    expect(sent[0]!.text).toContain("USD 9000");
  });
});

describe("notifyDealRated (QA-457)", () => {
  it("mails the operator — subject carries the stars, body the new standing", async () => {
    const repo = await getMemoryRepo();
    const { opUser, op, listing, rfq, quote } = await fixture(repo);
    const deal = await repo.createDeal({
      quoteId: quote.id,
      operatorId: op.id,
      amount: 9000,
      currency: "USD",
      feePct: 0.03,
      feeAmount: 270,
      invoiceStatus: "pending",
    });
    // A prior rating exists → the mail reports the post-write standing.
    const d2 = await repo.createDeal({
      quoteId: (
        await repo.createQuote({
          rfqId: rfq.id,
          operatorId: op.id,
          amount: 8000,
          currency: "USD",
          message: "",
        })
      ).id,
      operatorId: op.id,
      amount: 8000,
      currency: "USD",
      feePct: 0.03,
      feeAmount: 240,
      invoiceStatus: "pending",
    });
    await repo.rateDeal(d2.id, 4);
    const before = email.readOutbox(process.env.EMAIL_OUTBOX_DIR).length;

    await notifyDealRated(repo, deal, 5);

    const sent = email
      .readOutbox(process.env.EMAIL_OUTBOX_DIR)
      .slice(before)
      .filter((m) => m.to === opUser.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("The buyer rated your deal ★ 5");
    expect(sent[0]!.text).toContain(listing.title);
    // Standing = (4+5)/2 — the summary read reflects THIS rating already
    // persisted? No — notify is called after rateDeal CASed `deal`, but the
    // unit path writes no rating on `deal` itself: the summary covers only
    // d2's ★4 → "★ 4.0 across 1 rated deal".
    expect(sent[0]!.text).toContain("★ 4.0 across 1 rated deal");
  });

  it("silent when the operator row is gone — never throws", async () => {
    const repo = await getMemoryRepo();
    const deal = await repo.createDeal({
      quoteId: "q-gone",
      operatorId: "op-gone",
      amount: 1,
      currency: "USD",
      feePct: 0.03,
      feeAmount: 0,
      invoiceStatus: "pending",
    });
    await expect(notifyDealRated(repo, deal, 3)).resolves.toBeUndefined();
  });
});
