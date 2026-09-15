import { describe, expect, it } from "vitest";
import { applyPaymentEvent } from "./billing";
import { getMemoryRepo } from "./repo/memory";

describe("applyPaymentEvent", () => {
  it("subscription.activated upgrades operator to the event plan", async () => {
    const repo = await getMemoryRepo();
    const op = (await repo.listOperators()).find((o) => o.plan === "free")!;
    const applied = await applyPaymentEvent(repo, {
      kind: "subscription.activated",
      customerId: op.id,
      subscriptionId: "sub_1",
      metadata: { operatorId: op.id, plan: "pro" },
    });
    expect(applied).toBe(true);
    expect((await repo.getOperator(op.id))!.plan).toBe("pro");
    const sub = await repo.getSubscription(op.id);
    expect(sub!.status).toBe("active");
    expect(sub!.plan).toBe("pro");
  });

  it("subscription.canceled downgrades to free + marks the sub canceled", async () => {
    const repo = await getMemoryRepo();
    const op = (await repo.listOperators()).find((o) => o.plan === "free")!;
    await applyPaymentEvent(repo, {
      kind: "subscription.activated",
      customerId: op.id,
      subscriptionId: "sub_1",
      metadata: { operatorId: op.id, plan: "pro" },
    });
    await applyPaymentEvent(repo, {
      kind: "subscription.canceled",
      customerId: op.id,
      subscriptionId: "sub_1",
      metadata: { operatorId: op.id },
    });
    expect((await repo.getOperator(op.id))!.plan).toBe("free");
    expect((await repo.getSubscription(op.id))!.status).toBe("canceled");
  });

  it("ignored events are a no-op", async () => {
    const repo = await getMemoryRepo();
    expect(await applyPaymentEvent(repo, { kind: "ignored", type: "x" })).toBe(
      false,
    );
  });
});
