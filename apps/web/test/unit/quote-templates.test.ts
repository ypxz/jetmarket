/**
 * /api/operator/quote-templates (QA-527): session-gated CRUD for the
 * operator's saved quote presets — GET lists own rows, POST upserts by
 * name, DELETE is owner-scoped. Memory repo via the session-cookie mock.
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
import type { Repo } from "../../lib/repo/types";
import { getMemoryRepo } from "../../lib/repo/memory";
import { GET, POST } from "../../app/api/operator/quote-templates/route";
import { DELETE } from "../../app/api/operator/quote-templates/[id]/route";

const asUser = (id: string | null) =>
  id
    ? jar.set(sessionCookie, signSession(id, 1))
    : jar.delete(sessionCookie);

const post = (body?: unknown) =>
  new Request("http://test.local/api/operator/quote-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
const del = () =>
  new Request("http://test.local/api/operator/quote-templates/x", {
    method: "DELETE",
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function opFixture(repo: Repo) {
  const u = await repo.createUser(
    `tpl-${Math.random().toString(36).slice(2, 8)}@test.dev`,
    "operator",
  );
  const op = await repo.upsertOperator({
    userId: u.id,
    name: "Tpl Ops",
    baseAirport: "ZRH",
    fleetSummary: "",
    verified: true,
    plan: "free",
  });
  return { u, op };
}

describe("/api/operator/quote-templates (QA-527)", () => {
  it("401 unauth, 409 without an operator profile", async () => {
    asUser(null);
    expect((await GET()).status).toBe(401);
    expect((await POST(post({ name: "x", amount: 1 }))).status).toBe(401);
    const repo = await getMemoryRepo();
    const u = await repo.createUser(
      `tpl-noop-${Math.random().toString(36).slice(2, 8)}@test.dev`,
      "operator",
    );
    asUser(u.id);
    expect((await GET()).status).toBe(409);
    expect((await POST(post({ name: "x", amount: 1 }))).status).toBe(409);
  });

  it("POST upserts by name; GET lists own rows; 422 on bad input", async () => {
    const repo = await getMemoryRepo();
    const { u, op } = await opFixture(repo);
    asUser(u.id);

    const bad = await POST(post({ name: " ", amount: 100 }));
    expect(bad.status).toBe(422);
    const neg = await POST(post({ name: "x", amount: -5 }));
    expect(neg.status).toBe(422);

    const res = await POST(
      post({ name: "Weekday", amount: 28000, message: "incl. repos" }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      template: { id: string; operatorId: string };
    };
    expect(created.template.operatorId).toBe(op.id);

    // Same name replaces in place.
    const res2 = await POST(
      post({ name: "Weekday", amount: 29000, message: "v2" }),
    );
    const upd = (await res2.json()) as {
      template: { id: string; amount: number; message: string };
    };
    expect(upd.template.id).toBe(created.template.id);
    expect(upd.template.amount).toBe(29000);

    const list = (await (await GET()).json()) as {
      templates: { name: string; amount: number }[];
    };
    expect(list.templates.map((x) => x.name)).toEqual(["Weekday"]);
    expect(list.templates[0]!.amount).toBe(29000);
  });

  it("DELETE is owner-scoped: foreign ids 404; replay 404", async () => {
    const repo = await getMemoryRepo();
    const a = await opFixture(repo);
    const b = await opFixture(repo);
    const tpl = await repo.upsertQuoteTemplate({
      operatorId: a.op.id,
      name: "Mine",
      amount: 100,
      message: "",
    });

    // Other operator can't delete it.
    asUser(b.u.id);
    expect((await DELETE(del(), params(tpl.id))).status).toBe(404);
    expect(await repo.listQuoteTemplates(a.op.id)).toHaveLength(1);

    // Owner deletes once, then 404 on replay.
    asUser(a.u.id);
    expect((await DELETE(del(), params(tpl.id))).status).toBe(200);
    expect((await DELETE(del(), params(tpl.id))).status).toBe(404);
    expect(await repo.listQuoteTemplates(a.op.id)).toEqual([]);
  });
});
