/**
 * GET /api/operators (QA-312): the handler passed the repo Promise straight
 * to NextResponse.json, so it serialized to {} — truthy, so the onboarding
 * prefill never loaded fields and /app/listings/new thought a profile-less
 * user already had one. Now awaited; private row → no-store.
 */
import { describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { value: jar.get(name) } : undefined,
  }),
}));

import { sessionCookie, signSession } from "../../lib/auth";
import { getMemoryRepo } from "../../lib/repo/memory";
import { GET as getOperator } from "../../app/api/operators/route";

const asUser = (id: string | null) =>
  id
    ? jar.set(sessionCookie, signSession(id, 1))
    : jar.delete(sessionCookie);

describe("GET /api/operators (QA-312)", () => {
  it("returns null (not {}) when the user has no profile, with no-store", async () => {
    const repo = await getMemoryRepo();
    const u = await repo.createUser(
      `noprof-${Math.random().toString(36).slice(2, 8)}@test.dev`,
      "operator",
    );
    asUser(u.id);
    const res = await getOperator();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toBeNull();
  });

  it("returns the real operator row once it exists", async () => {
    const repo = await getMemoryRepo();
    const u = await repo.createUser(
      `op-${Math.random().toString(36).slice(2, 8)}@test.dev`,
      "operator",
    );
    const op = await repo.upsertOperator({
      userId: u.id,
      name: "Hangar Ops",
      baseAirport: "ZRH",
      fleetSummary: "",
      verified: false,
      plan: "free",
    });
    asUser(u.id);
    const res = await getOperator();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string; name?: string };
    expect(body.id).toBe(op.id);
    expect(body.name).toBe("Hangar Ops");
  });
});

describe("POST /api/operator/notify-prefs (QA-505)", () => {
  it("flips the match-mail switch and persists it; upserts preserve", async () => {
    const { POST: setPrefs } = await import(
      "../../app/api/operator/notify-prefs/route"
    );
    const repo = await getMemoryRepo();
    const u = await repo.createUser(
      `prefs-${Math.random().toString(36).slice(2, 8)}@test.dev`,
      "operator",
    );
    const op = await repo.upsertOperator({
      userId: u.id,
      name: "Prefs Air",
      baseAirport: "ZRH",
      fleetSummary: "",
      verified: true,
      plan: "pro",
    });
    expect(op.notifyRfqMatch).toBe(true);
    asUser(u.id);

    const post = (body: unknown) =>
      new Request("http://test.local/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const off = await setPrefs(post({ rfqMatch: false }));
    expect(off.status).toBe(200);
    expect((await repo.getOperator(op.id))?.notifyRfqMatch).toBe(false);
    const on = await setPrefs(post({ rfqMatch: true }));
    expect(on.status).toBe(200);
    expect((await repo.getOperator(op.id))?.notifyRfqMatch).toBe(true);
    asUser(null);
  });

  it("401s logged out", async () => {
    const { POST: setPrefs } = await import(
      "../../app/api/operator/notify-prefs/route"
    );
    const res = await setPrefs(
      new Request("http://test.local/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rfqMatch: false }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/operator/rfqs/[id]/note (QA-524)", () => {
  async function fixture() {
    const { POST: setNote } = await import(
      "../../app/api/operator/rfqs/[id]/note/route"
    );
    const repo = await getMemoryRepo();
    const u = await repo.createUser(
      `noter-${Math.random().toString(36).slice(2, 8)}@test.dev`,
      "operator",
    );
    const op = await repo.upsertOperator({
      userId: u.id,
      name: "Note Ops",
      baseAirport: "ZRH",
      fleetSummary: "",
      verified: true,
      plan: "pro",
    });
    const listing = await repo.createListing({
      operatorId: op.id,
      vertical: "jets",
      type: "charter",
      title: "Note jet",
      price: 10000,
      currency: "USD",
      photos: [],
      attributes: {},
    });
    const rfq = await repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail: "buyer@test.dev",
      fields: {},
      dedupeKey: Math.random().toString(36).slice(2),
    });
    return { setNote, repo, u, op, rfq };
  }
  const post = (note: string) =>
    new Request("http://test.local/api/operator/rfqs/x/note", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note }),
    });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it("sets, overwrites, and clears a private note; guards hold", async () => {
    const { setNote, repo, u, op, rfq } = await fixture();
    // 401 logged out.
    asUser(null);
    expect((await setNote(post("x"), params(rfq.id))).status).toBe(401);
    asUser(u.id);
    // 404 on a stranger's rfq.
    expect((await setNote(post("x"), params("00000000-0000-4000-8000-000000000099"))).status).toBe(404);
    // 422 over the cap.
    expect(
      (await setNote(post("x".repeat(501)), params(rfq.id))).status,
    ).toBe(422);
    // 200 set → stored note echoes back.
    const res = await setNote(post("called this buyer"), params(rfq.id));
    expect(res.status).toBe(200);
    expect((await res.json()).note).toBe("called this buyer");
    // Overwrite.
    const res2 = await setNote(post("suspicious"), params(rfq.id));
    expect((await res2.json()).note).toBe("suspicious");
    // Empty clears.
    const res3 = await setNote(post("  "), params(rfq.id));
    expect((await res3.json()).note).toBeNull();
    expect(await repo.listRfqNotes(op.id, [rfq.id])).toEqual([]);
  });
});
