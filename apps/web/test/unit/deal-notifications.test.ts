/**
 * Deal-close notifications (QA-149): accepting a quote emails the winning
 * operator AND the buyer (their only receipt — buyers never sign in).
 * The mock email provider writes one JSON per message to EMAIL_OUTBOX_DIR;
 * set it before the provider singleton initializes (per-file vitest worker).
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
import { getMemoryRepo } from "../../lib/repo/memory";
import type { Repo } from "../../lib/repo/types";
import { POST as acceptQuote } from "../../app/api/quotes/[id]/accept/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) =>
  new Request("http://test.local/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
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
  const buyerEmail = `buyer-${tag}@test.dev`;
  const rfq = await repo.createRfq({
    vertical: "jets",
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

describe("POST /api/quotes/[id]/accept notifications (QA-149)", () => {
  it("emails the winning operator and the buyer on accept", async () => {
    const repo = await getMemoryRepo();
    const { opUser, quote, rfq, buyerEmail } = await fixture(repo);

    const res = await acceptQuote(
      post({ buyerEmail, token: rfq.accessToken }),
      params(quote.id),
    );
    expect(res.status).toBe(200);

    const box = email.readOutbox(process.env.EMAIL_OUTBOX_DIR);
    const toOp = box.find((m) => m.to === opUser.email);
    const toBuyer = box.find((m) => m.to === buyerEmail);
    expect(toOp?.subject).toContain("accepted");
    expect(toOp?.text).toContain(buyerEmail); // contact handoff
    expect(toOp?.text).toContain("9000");
    expect(toBuyer?.subject).toContain("accepted");
    expect(toBuyer?.text).toContain("Ops");
  });
});
