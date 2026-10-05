/**
 * QA-544 portability route (GET /api/account/export): session proof,
 * RFQ-bearer proof, the denial matrix, and the JSON download headers.
 * Runs against the memory repo with the real route handler.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { value: jar.get(name) } : undefined,
  }),
}));

import { sessionCookie, signSession } from "../../lib/auth";
import { getMemoryRepo } from "../../lib/repo/memory";
import type { Repo } from "../../lib/repo/types";
import { GET as exportGet } from "../../app/api/account/export/route";

const exp = (opts?: {
  email?: string;
  token?: string;
  bearerHeader?: boolean;
}) => {
  const q = new URLSearchParams();
  if (opts?.email) q.set("email", opts.email);
  if (opts?.token && !opts.bearerHeader) q.set("t", opts.token);
  const headers: Record<string, string> = {};
  if (opts?.token && opts.bearerHeader) headers["x-rfq-token"] = opts.token;
  return exportGet(new Request(`http://test.local/api/account/export?${q}`, { headers }));
};

let repo: Repo;

beforeEach(async () => {
  jar.clear();
  repo = await getMemoryRepo();
});

describe("account export (QA-544)", () => {
  it("session: downloads the mailbox's tree as JSON", async () => {
    const email = `exp-${Date.now().toString(36)}@test.dev`;
    const user = await repo.createUser(email, "buyer");
    jar.set(sessionCookie, signSession(user.id, 1));
    const rfq = await repo.createRfq({
      vertical: "jets",
      listingId: null,
      buyerEmail: email,
      fields: { email, note: "keep" },
    });
    await repo.createSearchAlert({
      vertical: "jets",
      email,
      params: {},
      token: `tok-${user.id}`,
      dedupeKey: `dk-${user.id}`,
    });

    const res = await exp();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="jetmarket-export-\d{4}-\d{2}-\d{2}\.json"/,
    );
    expect(res.headers.get("cache-control")).toContain("no-store");
    const data = (await res.json()) as {
      email: string;
      user?: { id: string };
      rfqs: { rfq: { id: string } }[];
      searchAlerts: unknown[];
    };
    expect(data.email).toBe(email);
    expect(data.user?.id).toBe(user.id);
    expect(data.rfqs[0]!.rfq.id).toBe(rfq.id);
    expect(data.searchAlerts).toHaveLength(1);
    // Read-only — the mailbox is still there.
    expect(await repo.getRfq(rfq.id)).toBeTruthy();
  });

  it("bearer: emailed-links buyer exports via ?email= + token", async () => {
    const email = `exp-b-${Date.now().toString(36)}@test.dev`;
    const rfq = await repo.createRfq({
      vertical: "jets",
      listingId: null,
      buyerEmail: email,
      fields: { email },
    });
    // Query-param proof AND header proof both work.
    for (const opts of [
      { email, token: rfq.accessToken },
      { email, token: rfq.accessToken, bearerHeader: true },
    ]) {
      const res = await exp(opts);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { email: string; user?: unknown };
      expect(data.email).toBe(email);
      expect(data.user).toBeUndefined();
    }
  });

  it("denials: no email → 400; email without proof → 401; bad token → 401", async () => {
    const email = `exp-d-${Date.now().toString(36)}@test.dev`;
    await repo.createRfq({
      vertical: "jets",
      listingId: null,
      buyerEmail: email,
      fields: { email },
    });
    expect((await exp()).status).toBe(400);
    expect((await exp({ email })).status).toBe(401);
    expect((await exp({ email, token: "deadbeef" })).status).toBe(401);
    // A token from ANOTHER mailbox doesn't unlock this one.
    const other = await repo.createRfq({
      vertical: "jets",
      listingId: null,
      buyerEmail: `exp-o-${Date.now().toString(36)}@test.dev`,
      fields: {},
    });
    expect(
      (await exp({ email, token: other.accessToken })).status,
    ).toBe(401);
  });
});
