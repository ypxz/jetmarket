import { describe, expect, it } from "vitest";
import {
  acceptQuote,
  canTransitionQuote,
  InvalidQuoteTransition,
  isTerminalQuoteStatus,
  transitionQuote,
} from "./quotes";
import type { Quote } from "./types";
import type { VerticalConfig } from "./vertical-config";

const config: Pick<VerticalConfig, "fees"> = {
  fees: {
    subscriptionPlans: [],
    successFeePct: { charter: 3, empty_leg: 3, aircraft_sale: 1.5 },
  },
};

function quote(status: Quote["status"]): Quote {
  return {
    id: "q1",
    rfqId: "r1",
    operatorId: "o1",
    amountMinor: 5_000_000, // $50k charter
    currency: "USD",
    message: "available next week",
    status,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
  };
}

describe("quote state machine", () => {
  it("allows the happy path draft -> sent -> accepted", () => {
    expect(canTransitionQuote("draft", "sent")).toBe(true);
    expect(canTransitionQuote("sent", "accepted")).toBe(true);
    expect(canTransitionQuote("sent", "declined")).toBe(true);
    expect(canTransitionQuote("sent", "expired")).toBe(true);
    expect(canTransitionQuote("sent", "withdrawn")).toBe(true);
  });

  it("rejects skips and reversals", () => {
    expect(canTransitionQuote("draft", "accepted")).toBe(false);
    expect(canTransitionQuote("accepted", "sent")).toBe(false);
    expect(canTransitionQuote("declined", "sent")).toBe(false);
    expect(canTransitionQuote("sent", "draft")).toBe(false);
  });

  it("marks terminal states", () => {
    for (const s of ["accepted", "declined", "expired", "withdrawn"] as const) {
      expect(isTerminalQuoteStatus(s)).toBe(true);
    }
    expect(isTerminalQuoteStatus("sent")).toBe(false);
    expect(isTerminalQuoteStatus("draft")).toBe(false);
  });

  it("transitionQuote returns an updated copy or throws", () => {
    const at = new Date("2026-09-15T12:00:00Z");
    const sent = transitionQuote(quote("draft"), "sent", at);
    expect(sent.status).toBe("sent");
    expect(sent.updatedAt).toBe(at);
    expect(() => transitionQuote(sent, "draft")).toThrow(
      InvalidQuoteTransition,
    );
    expect(() => transitionQuote(quote("accepted"), "sent")).toThrow(
      /invalid quote transition: accepted -> sent/,
    );
  });
});

describe("acceptQuote", () => {
  it("accepts and derives the success-fee deal (3% charter)", () => {
    const at = new Date("2026-09-15T12:00:00Z");
    const { quote: q, deal } = acceptQuote(config, quote("sent"), {
      listingType: "charter",
      dealId: "d1",
      at,
    });
    expect(q.status).toBe("accepted");
    expect(deal).toEqual({
      id: "d1",
      quoteId: "q1",
      closedAt: at,
      feePct: 3,
      feeAmountMinor: 150_000,
      currency: "USD",
      invoiceStatus: "pending",
      invoiceRef: null,
    });
  });

  it("uses 1.5% for aircraft sales", () => {
    const sale = { ...quote("sent"), amountMinor: 2_000_000_000 }; // $20M
    const { deal } = acceptQuote(config, sale, {
      listingType: "aircraft_sale",
      dealId: "d2",
    });
    expect(deal.feePct).toBe(1.5);
    expect(deal.feeAmountMinor).toBe(30_000_000);
  });

  it("refuses to accept a non-sent quote", () => {
    expect(() =>
      acceptQuote(config, quote("draft"), {
        listingType: "charter",
        dealId: "d3",
      }),
    ).toThrow(InvalidQuoteTransition);
    expect(() =>
      acceptQuote(config, quote("declined"), {
        listingType: "charter",
        dealId: "d4",
      }),
    ).toThrow(InvalidQuoteTransition);
  });

  it("refuses unknown listing types", () => {
    expect(() =>
      acceptQuote(config, quote("sent"), {
        listingType: "blimp",
        dealId: "d5",
      }),
    ).toThrow(/no success fee/);
  });
});
