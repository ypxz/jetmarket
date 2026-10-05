/**
 * QA-543 self-delete route (POST /api/account/delete): session proof,
 * RFQ-bearer proof, and the denial matrix. Runs against the memory repo
 * with the real route handler.
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
import { POST as deletePost } from "../../app/api/account/delete/route";

const del = (opts?: {
  email?: string;
  token?: string;
  bearerHeader?: boolean;
}) => {
  const q = new URLSearchParams();
  if (opts?.email) q.set("email", opts.email);
  if (opts?.token && !opts.bearerHeader) q.set("t", opts.token);
  const headers: Record<string, string> = {};
  if (opts?.token && opts.bearerHeader) headers["x-rfq-token"] = opts.token;
  return deletePost(
    new Request(`http://test.local/api/account/delete?${q}`, {
      method: "POST",
      headers,
    }),
  );
};

let repo: Repo;

beforeEach(async () => {
  jar.clear();
  repo = await getMemoryRepo();
});

describe("account self-delete (QA-543)", () => {
  it("session: wipes the mailbox's surfaces and clears the cookie", async () => {
    const email = `wipe-${Date.now().toString(36)}@test.dev`;
    const user = await repo.createUser(email, "buyer");
    jar.set(sessionCookie, signSession(user.id, 1));
    await repo.createRfq({
      vertical: "jets",
      listingId: null,
      buyerEmail: email,
      fields: { email },
    });
    await repo.createSearchAlert({
      vertical: "jets",
      email,
      params: {},
      token: `tok-${user.id}`,
      dedupeKey: `dk-${user.id}`,
    });

    const res = await del();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rfqs: number;
      alerts: number;
      userDeleted: boolean;
    };
    expect(body.rfqs).toBe(1);
    expect(body.alerts).toBe(1);
    expect(body.userDeleted).toBe(true);
    // Session cookie cleared — the next render isn't an orphan lookup.
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toContain(`${sessionCookie}=`);
    expect(sc).toMatch(/Max-Age=0/i);
    expect(await repo.getUser(user.id)).toBeUndefined();
    expect(await repo.listRfqs({ buyerEmail: email })).toHaveLength(0);
  });

  it("bearer: emailed-links buyer deletes without a session", async () => {
    const email = `wipe-b-${Date.now().toString(36)}@test.dev`;
    const rfq = await repo.createRfq({
      vertical: "jets",
      listingId: null,
      buyerEmail: email,
      fields: { email },
    });
    const res = await del({ email, token: rfq.accessToken });
    expect(res.status).toBe(200);
    expect((await res.json()).rfqs).toBe(1);
    // Header form is the same proof.
    const email2 = `wipe-h-${Date.now().toString(36)}@test.dev`;
    const rfq2 = await repo.createRfq({
      vertical: "jets",
      listingId: null,
      buyerEmail: email2,
      fields: { email: email2 },
    });
    const res2 = await del({
      email: email2,
      token: rfq2.accessToken,
      bearerHeader: true,
    });
    expect(res2.status).toBe(200);
  });

  it("denial matrix: no proof 401, foreign token 401, missing email 400", async () => {
    const email = `wipe-x-${Date.now().toString(36)}@test.dev`;
    await repo.createRfq({
      vertical: "jets",
      listingId: null,
      buyerEmail: email,
      fields: { email },
    });
    expect((await del()).status).toBe(400); // nothing at all
    expect((await del({ email })).status).toBe(401); // email, no proof
    expect((await del({ email, token: "nope" })).status).toBe(401);
    // Someone else's bearer proves THEIR mailbox, not this one.
    const other = await repo.createRfq({
      vertical: "jets",
      listingId: null,
      buyerEmail: `other-${Date.now().toString(36)}@test.dev`,
      fields: {},
    });
    expect((await del({ email, token: other.accessToken })).status).toBe(401);
    // And the RFQ survived every denial.
    expect(await repo.listRfqs({ buyerEmail: email })).toHaveLength(1);
  });

  it("deleting with a session ignores the ?email param (session wins)", async () => {
    const email = `wipe-s-${Date.now().toString(36)}@test.dev`;
    const user = await repo.createUser(email, "buyer");
    jar.set(sessionCookie, signSession(user.id, 1));
    // A ?email= param naming a stranger can't redirect the delete —
    // the session's own mailbox is the scope.
    const res = await del({ email: `stranger-${Date.now()}@test.dev` });
    expect(res.status).toBe(200);
    expect((await res.json()).userDeleted).toBe(true);
    expect(await repo.getUser(user.id)).toBeUndefined();
  });
});
