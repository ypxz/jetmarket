import { describe, expect, it, vi } from "vitest";
import { matchOperators } from "@jetmarket/domain";
import { fanoutRfq } from "@/lib/fanout";
import { getRepo } from "@/lib/repo";
import { verticalConfig } from "@/lib/vertical";

// Spy so QA-221 can pin that matching runs on the active vertical's plan
// table, not the domain's defaultPlans() mirror. Calls still forward.
vi.mock("@jetmarket/domain", async (importOriginal) => {
  const m = await importOriginal<typeof import("@jetmarket/domain")>();
  return { ...m, matchOperators: vi.fn(m.matchOperators) };
});

/**
 * Memory-mode fan-out (QA-89): POST /rfqs runs domain matching inline when
 * no DATABASE_URL is set. The repo impls' visibility contract is covered by
 * the integration suite; this checks the route-level orchestration: owner
 * exclusion, deliverAt gating, rfq status flip.
 */
describe("fanoutRfq (memory mode)", () => {
  it("matches non-owner operators, delays free/unverified, flips rfq to matched", async () => {
    const repo = await getRepo();
    const tag = `f${Date.now().toString(36)}`;

    const mkOp = async (n: string, plan: "free" | "pro", verified: boolean) => {
      const u = await repo.createUser(`${n}-${tag}@test.dev`, "operator");
      return repo.upsertOperator({
        userId: u.id,
        name: `${n} ${tag}`,
        baseAirport: "ZRH",
        fleetSummary: "",
        verified,
        plan,
      });
    };
    const owner = await mkOp("owner", "pro", true);
    const instant = await mkOp("instant", "pro", true);
    const delayed = await mkOp("delayed", "free", false);

    const listing = await repo.createListing({
      operatorId: owner.id,
      vertical: "jets",
      type: "charter",
      title: `Fanout ${tag}`,
      price: 9000,
      currency: "USD",
      photos: [],
      attributes: { aircraftCategory: "light", seats: 6 },
    });
    const rfq = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail: `b-${tag}@test.dev`,
      // No category/seats requirements -> every candidate fits on score.
      fields: { departure: "ZRH", arrival: "NCE" },
    });

    await fanoutRfq(repo, rfq, listing);

    // Pro+verified delivers instantly; free+unverified is delayed (24h+6h);
    // the owner is excluded so they only get the direct route email.
    expect(await repo.hasRfqMatch(rfq.id, instant.id)).toBe(true);
    expect(await repo.hasRfqMatch(rfq.id, delayed.id)).toBe(false);
    expect(await repo.hasRfqMatch(rfq.id, owner.id)).toBe(false);

    // QA-221: the plan table handed to matching IS the vertical config's —
    // not defaultPlans(); a vertical changing rfqDelayHours actually applies.
    expect(vi.mocked(matchOperators).mock.calls.at(-1)?.[2]).toBe(
      verticalConfig().fees.subscriptionPlans,
    );

    expect((await repo.getRfq(rfq.id))?.status).toBe("matched");
    expect(
      (await repo.listRfqs({ operatorId: instant.id })).map((r) => r.id),
    ).toContain(rfq.id);
    expect(
      (await repo.listRfqs({ operatorId: delayed.id })).map((r) => r.id),
    ).not.toContain(rfq.id);
  });
});
