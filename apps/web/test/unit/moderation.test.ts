/**
 * Listing moderation (QA-247): admin pause/archive emails the operator owner,
 * and an archived listing is terminal for the owner — PATCH-ing it back to
 * any other status is refused so moderation can't be undone from the
 * dashboard (or the two-hop archived→paused→active).
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
import {
  notifyDealInvoiceVoided,
  notifyListingModerated,
  notifyOperatorVerified,
} from "../../lib/notify";
import { getMemoryRepo } from "../../lib/repo/memory";
import type { Repo } from "../../lib/repo/types";
import { PATCH as patchListing } from "../../app/api/listings/[id]/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (body: unknown) =>
  new Request("http://test.local/api", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => jar.clear());

async function fixture(repo: Repo) {
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
    vertical: "jets",
    type: "charter",
    title: `Jet ${tag}`,
    price: 9000,
    currency: "USD",
    photos: [],
    attributes: {},
  });
  return { opUser, op, listing };
}

function signIn(userId: string, sessionVersion: number) {
  jar.set(sessionCookie, signSession(userId, sessionVersion));
}

describe("listing moderation", () => {
  it("admin moderation emails the operator owner", async () => {
    const repo = await getMemoryRepo();
    const { opUser, listing } = await fixture(repo);
    await repo.updateListingStatus(listing.id, "archived");
    const archived = (await repo.getListing(listing.id))!;

    await notifyListingModerated(repo, archived, "archived");

    const box = email.readOutbox(process.env.EMAIL_OUTBOX_DIR);
    const toOp = box.find(
      (m) => m.to === opUser.email && m.subject.includes("archived"),
    );
    expect(toOp?.subject).toContain(listing.title);
    expect(toOp?.text).toContain("moderation");
  });

  it("archived listings reject owner status transitions", async () => {
    const repo = await getMemoryRepo();
    const { opUser, listing } = await fixture(repo);
    await repo.updateListingStatus(listing.id, "archived");
    signIn(opUser.id, opUser.sessionVersion);

    for (const status of ["active", "paused", "draft"]) {
      const res = await patchListing(patch({ status }), params(listing.id));
      expect(res.status, `archived → ${status}`).toBe(403);
      expect((await repo.getListing(listing.id))?.status).toBe("archived");
    }
  });

  it("paused listings still allow owner reactivation", async () => {
    const repo = await getMemoryRepo();
    const { opUser, listing } = await fixture(repo);
    await repo.updateListingStatus(listing.id, "paused");
    signIn(opUser.id, opUser.sessionVersion);

    const res = await patchListing(patch({ status: "active" }), params(listing.id));
    expect(res.status).toBe(200);
    expect((await repo.getListing(listing.id))?.status).toBe("active");
  });
});

describe("operator verification (QA-249)", () => {
  it("verify and unverify both email the owner", async () => {
    const repo = await getMemoryRepo();
    const { opUser, op } = await fixture(repo);

    await notifyOperatorVerified(repo, op.id, true);
    let box = email.readOutbox(process.env.EMAIL_OUTBOX_DIR);
    let toOp = box.find(
      (m) => m.to === opUser.email && m.subject.includes("verified"),
    );
    expect(toOp?.subject).toContain("verified");
    expect(toOp?.text).toContain(op.name);

    await notifyOperatorVerified(repo, op.id, false);
    box = email.readOutbox(process.env.EMAIL_OUTBOX_DIR);
    toOp = box.find(
      (m) => m.to === opUser.email && m.subject.includes("no longer verified"),
    );
    expect(toOp?.text).toContain("badge");
  });
});

describe("deal invoice void (QA-249)", () => {
  it("void emails the operator owner", async () => {
    const repo = await getMemoryRepo();
    const { opUser, op, listing } = await fixture(repo);
    const rfq = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail: "b@test.dev",
      fields: {},
    });
    const quote = await repo.createQuote({
      rfqId: rfq.id,
      operatorId: op.id,
      amount: 9000,
      currency: "USD",
      message: "",
    });
    const deal = await repo.createDeal({
      quoteId: quote.id,
      operatorId: op.id,
      amount: 9000,
      currency: "USD",
      feePct: 0.03,
      feeAmount: 270,
      invoiceStatus: "invoiced",
      invoiceRef: "inv_test",
    });
    await repo.setDealInvoice(deal.id, "void", undefined, [
      "pending",
      "invoiced",
    ]);

    await notifyDealInvoiceVoided(repo, deal);

    const box = email.readOutbox(process.env.EMAIL_OUTBOX_DIR);
    const toOp = box.find(
      (m) => m.to === opUser.email && m.subject.includes("voided"),
    );
    expect(toOp?.subject).toContain("voided");
    expect(toOp?.text).toContain("270");
  });
});
