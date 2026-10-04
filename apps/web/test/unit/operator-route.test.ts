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
