import { describe, expect, it } from "vitest";
import { MockPaymentsProvider } from "./mock";

const payments = () =>
  new MockPaymentsProvider({
    appUrl: "http://localhost:3000",
    nextId: ((n) => (p) => `${p}_t${++n}`)(0),
  });

describe("MockPaymentsProvider", () => {
  it("returns deterministic checkout/portal/invoice shapes", async () => {
    const p = payments();
    const cs = await p.createCheckoutSession({
      operatorId: "op1",
      plan: "pro",
      successUrl: "http://x/s",
      cancelUrl: "http://x/c",
    });
    expect(cs.id).toBe("cs_t1");
    expect(cs.url).toContain("mock-checkout");
    expect(cs.url).toContain("plan=pro");

    const portal = await p.createPortalSession({
      customerId: "cus1",
      returnUrl: "http://x",
    });
    expect(portal.url).toContain("mock-portal");

    const inv = await p.createInvoice({
      customerId: "cus1",
      amountMinor: 28_200,
      currency: "usd",
      description: "success fee",
    });
    expect(inv.amountMinor).toBe(28_200);
    expect(inv.status).toBe("paid");
  });

  it("normalizes webhook payloads into subscription events", async () => {
    const p = payments();
    const ev = await p.handleWebhook(
      JSON.stringify({
        type: "subscription.activated",
        customerId: "cus_1",
        subscriptionId: "sub_1",
        metadata: { operatorId: "op1" },
      }),
    );
    expect(ev).toEqual({
      kind: "subscription.activated",
      customerId: "cus_1",
      subscriptionId: "sub_1",
      metadata: { operatorId: "op1" },
    });

    const other = await p.handleWebhook(JSON.stringify({ type: "charge.x" }));
    expect(other).toEqual({ kind: "ignored", type: "charge.x" });
    expect(p.events).toHaveLength(2);
  });
});
