/**
 * Operator match-mail unsubscribe (QA-541): the signed per-mail link
 * mutes `notify_rfq_match` without a session — same pref the QA-505
 * dashboard toggle flips. Route runs against the memory repo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { value: jar.get(name) } : undefined,
  }),
}));

import { signOpUnsub } from "@jetmarket/config";
import { getMemoryRepo } from "../../lib/repo/memory";
import type { Repo } from "../../lib/repo/types";
import { GET as unsubGet } from "../../app/api/operator/notify/unsubscribe/route";

const unsub = (token: string) =>
  unsubGet(
    new Request(
      `http://test.local/api/operator/notify/unsubscribe?token=${encodeURIComponent(token)}`,
    ),
  );

let repo: Repo;

beforeEach(async () => {
  vi.restoreAllMocks();
  jar.clear();
  repo = await getMemoryRepo();
});

async function mkOp() {
  const user = await repo.createUser(`ops-${Date.now()}@test.dev`, "operator");
  return repo.upsertOperator({
    userId: user.id,
    name: "Unsub Ops",
    baseAirport: "ZRH",
    fleetSummary: "1x",
    verified: false,
    plan: "free",
  });
}

describe("GET /api/operator/notify/unsubscribe (QA-541)", () => {
  it("a signed token mutes match mail and lands on the notice", async () => {
    const op = await mkOp();
    expect(op.notifyRfqMatch).toBe(true);
    const res = await unsub(signOpUnsub(op.id));
    expect([301, 302, 303, 307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toContain("notice=match-muted");
    expect((await repo.getOperator(op.id))!.notifyRfqMatch).toBe(false);
    // idempotent — a mail-client prefetch is the same GET
    const again = await unsub(signOpUnsub(op.id));
    expect(again.headers.get("location")).toContain("notice=match-muted");
    expect((await repo.getOperator(op.id))!.notifyRfqMatch).toBe(false);
  });

  it("unsigned, tampered, or unknown-operator tokens land invalid", async () => {
    const op = await mkOp();
    for (const bad of [
      "",
      "garbage",
      `${op.id}.${"0".repeat(64)}`,
      signOpUnsub("00000000-0000-4000-8000-000000000099"),
    ]) {
      const res = await unsub(bad);
      expect(res.headers.get("location")).toContain("error=invalid-token");
    }
    expect((await repo.getOperator(op.id))!.notifyRfqMatch).toBe(true);
  });
});
