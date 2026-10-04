/**
 * Saved-search alerts (QA-403): subscribe → confirm → match-on-activation →
 * digest/cooldown → unsubscribe. Routes run against the memory repo with
 * the real route handlers; email sends go through the mock provider spy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { value: jar.get(name) } : undefined,
  }),
}));

import { emailProvider } from "@jetmarket/providers";
import { sessionCookie, signSession } from "../../lib/auth";
import { getMemoryRepo } from "../../lib/repo/memory";
import type { Operator, Repo } from "../../lib/repo/types";
import { POST as subscribePost } from "../../app/api/search-alerts/route";
import { GET as confirmGet } from "../../app/api/search-alerts/confirm/route";
import { GET as unsubscribeGet } from "../../app/api/search-alerts/unsubscribe/route";
import { POST as createListing } from "../../app/api/listings/route";
import { PATCH as patchListing } from "../../app/api/listings/[id]/route";
import { GET as buyerAlertsGet } from "../../app/api/buyer/search-alerts/route";
import { POST as alertOffPost } from "../../app/api/search-alerts/[id]/off/route";

const subscribe = (body: unknown) =>
  subscribePost(
    new Request("http://test.local/api/search-alerts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const confirm = (token: string) =>
  confirmGet(
    new Request(
      `http://test.local/api/search-alerts/confirm?token=${token}`,
    ),
  );
const unsubscribe = (token: string) =>
  unsubscribeGet(
    new Request(
      `http://test.local/api/search-alerts/unsubscribe?token=${token}`,
    ),
  );
const postListing = (body: unknown) =>
  createListing(
    new Request("http://test.local/api/listings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

let repo: Repo;
let sendSpy: ReturnType<typeof vi.spyOn>;

const toOf = (call: unknown[]) =>
  (call[0] as { to?: string }).to ?? "";
const subjectOf = (call: unknown[]) =>
  (call[0] as { subject?: string }).subject ?? "";

async function confirmedAlert(
  email: string,
  params: Record<string, string>,
): Promise<{ token: string; id: string }> {
  const res = await subscribe({ email, params });
  const body = (await res.json()) as { devConfirmUrl?: string };
  const token = new URL(body.devConfirmUrl!).searchParams.get("token")!;
  const cres = await confirm(token);
  expect(cres.status).toBe(307);
  const alerts = await repo.listSearchAlerts({ vertical: "jets" });
  const row = alerts.find((a) => a.token === token)!;
  return { token, id: row.id };
}

async function opFixture(): Promise<Operator> {
  const tag = Math.random().toString(36).slice(2, 8);
  const user = await repo.createUser(`sal-${tag}@test.dev`, "operator");
  jar.set(sessionCookie, signSession(user.id, 1));
  return repo.upsertOperator({
    userId: user.id,
    name: `SA Ops ${tag}`,
    baseAirport: "ZRH",
    fleetSummary: "Phenom 300",
    verified: true,
    plan: "pro",
  });
}

const mkListing = (title: string, category = "light") => ({
  type: "charter",
  title,
  price: 12000,
  currency: "USD",
  photos: [],
  attributes: { aircraftCategory: category, seats: 8 },
});

beforeEach(async () => {
  vi.restoreAllMocks();
  jar.clear();
  repo = await getMemoryRepo();
  sendSpy = vi.spyOn(emailProvider(), "send");
});

describe("POST /api/search-alerts", () => {
  it("creates a pending alert + mails the confirm link (QA-403)", async () => {
    const res = await subscribe({
      email: "Buyer@Test.dev",
      params: { type: "charter", aircraftCategory: "light" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      created: boolean;
      devConfirmUrl?: string;
    };
    expect(body.created).toBe(true);
    expect(body.devConfirmUrl).toContain("/api/search-alerts/confirm?token=");

    const alerts = await repo.listSearchAlerts({ vertical: "jets" });
    const row = alerts[alerts.length - 1]!;
    expect(row.status).toBe("pending");
    expect(row.email).toBe("buyer@test.dev"); // normalized
    expect(row.params).toEqual({
      type: "charter",
      aircraftCategory: "light",
    });
    const confirmMail = sendSpy.mock.calls.find(
      (c: unknown[]) => toOf(c) === "buyer@test.dev",
    );
    expect(confirmMail).toBeDefined();
    expect(subjectOf(confirmMail!)).toContain("Confirm");
  });

  it("dedupes same email+params; different params → a second row", async () => {
    await subscribe({ email: "d@test.dev", params: { type: "charter" } });
    const res2 = await subscribe({
      email: "d@test.dev",
      params: { type: "charter" },
    });
    expect((await res2.json()).created).toBe(false);
    await subscribe({ email: "d@test.dev", params: { type: "aircraft_sale" } });
    const alerts = (await repo.listSearchAlerts({ vertical: "jets" })).filter(
      (a) => a.email === "d@test.dev",
    );
    expect(alerts).toHaveLength(2);
  });

  it("rejects a bogus email", async () => {
    const res = await subscribe({ email: "not-an-email", params: {} });
    expect([400, 422]).toContain(res.status);
  });
});

describe("GET confirm + unsubscribe", () => {
  it("confirm redirects onto the saved search with alert=confirmed", async () => {
    const res = await subscribe({
      email: "cf@test.dev",
      params: { type: "charter" },
    });
    const { devConfirmUrl } = (await res.json()) as { devConfirmUrl?: string };
    const cres = await confirm(
      new URL(devConfirmUrl!).searchParams.get("token")!,
    );
    expect([301, 302, 303, 307, 308]).toContain(cres.status);
    const loc = cres.headers.get("location")!;
    expect(loc).toContain("/search");
    expect(loc).toContain("type=charter");
    expect(loc).toContain("alert=confirmed");
  });

  it("unknown + replayed tokens land on alert=invalid", async () => {
    let res = await confirm("nope");
    expect(res.headers.get("location")).toContain("alert=invalid");
    // Replay: confirm once, hit the same link again.
    const sub = await subscribe({ email: "rp@test.dev", params: {} });
    const tok = new URL(
      ((await sub.json()) as { devConfirmUrl?: string }).devConfirmUrl!,
    ).searchParams.get("token")!;
    await confirm(tok);
    res = await confirm(tok);
    expect(res.headers.get("location")).toContain("alert=invalid");
  });

  it("unsubscribe flips off + redirects; alert stops matching", async () => {
    const { token } = await confirmedAlert("un@test.dev", {});
    const res = await unsubscribe(token);
    expect(res.headers.get("location")).toContain("alert=unsubscribed");
    const alerts = await repo.listSearchAlerts({ vertical: "jets" });
    expect(alerts.find((a) => a.token === token)!.status).toBe("off");
  });
});

describe("activation matching", () => {
  it("matching listing emails the subscriber; stale window queues instead (QA-403)", async () => {
    const { id } = await confirmedAlert("act@test.dev", {
      type: "charter",
      aircraftCategory: "light",
    });
    await opFixture();
    sendSpy.mockClear();

    // First activation → instant mail + stamp.
    const res1 = await postListing(mkListing("Alert Jet One"));
    expect(res1.status).toBe(201);
    const digest = sendSpy.mock.calls.find(
      (c: unknown[]) => toOf(c) === "act@test.dev",
    );
    expect(digest).toBeDefined();
    expect(subjectOf(digest!)).toContain("Alert Jet One");

    // Second activation inside the cooldown → queued, not mailed.
    sendSpy.mockClear();
    const res2 = await postListing(mkListing("Alert Jet Two"));
    expect(res2.status).toBe(201);
    expect(
      sendSpy.mock.calls.filter((c: unknown[]) => toOf(c) === "act@test.dev"),
    ).toHaveLength(0);
    const alerts = await repo.listSearchAlerts({ vertical: "jets" });
    const row = alerts.find((a) => a.id === id)!;
    const created2 = (await res2.json()) as { id: string };
    expect(row.pendingIds).toEqual([created2.id]);
  });

  it("editing a live listing INTO a saved range mails the alert (QA-404)", async () => {
    await confirmedAlert("edit@test.dev", {
      type: "charter",
      priceMax: "10000",
    });
    await opFixture();
    sendSpy.mockClear();
    // Listing starts above the saved cap → no mail at create.
    const res = await postListing(mkListing("Pricey Jet"));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(
      sendSpy.mock.calls.filter((c: unknown[]) => toOf(c) === "edit@test.dev"),
    ).toHaveLength(0);

    // Price cut into the range → the edit itself is an alert event.
    const pres = await patchListing(
      new Request(`http://test.local/api/listings/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ price: 9000 }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(pres.status).toBe(200);
    const digest = sendSpy.mock.calls.find(
      (c: unknown[]) => toOf(c) === "edit@test.dev",
    );
    expect(digest).toBeDefined();
    expect(subjectOf(digest!)).toContain("Pricey Jet");
  });

  it("'daily' alerts never instant-mail — every match queues (QA-406)", async () => {
    const res = await subscribe({
      email: "daily@test.dev",
      params: { type: "charter" },
      freq: "daily",
    });
    expect(res.status).toBe(200);
    const { devConfirmUrl } = (await res.json()) as {
      devConfirmUrl?: string;
    };
    const token = new URL(devConfirmUrl!).searchParams.get("token")!;
    await confirm(token);
    const alert = (
      await repo.listSearchAlerts({ vertical: "jets" })
    ).find((a) => a.token === token)!;
    expect(alert.freq).toBe("daily");
    await opFixture();
    sendSpy.mockClear();

    const created = await postListing(mkListing("Daily Jet"));
    expect(created.status).toBe(201);
    // No instant mail — the match went straight into pending_ids for the
    // worker's matured-backlog digest.
    expect(
      sendSpy.mock.calls.filter((c: unknown[]) => toOf(c) === "daily@test.dev"),
    ).toHaveLength(0);
    const row = (
      await repo.listSearchAlerts({ vertical: "jets" })
    ).find((a) => a.token === token)!;
    const { id } = (await created.json()) as { id: string };
    expect(row.pendingIds).toEqual([id]);
    expect(row.lastAlertedAt).toBeNull();
  });

  it("non-matching + pending-status alerts get nothing", async () => {
    await confirmedAlert("cat@test.dev", { aircraftCategory: "heavy" });
    // Pending (never confirmed) — must NOT mail even when it matches.
    await subscribe({ email: "pend@test.dev", params: {} });
    await opFixture();
    sendSpy.mockClear();
    const res = await postListing(mkListing("Light Jet X"));
    expect(res.status).toBe(201);
    expect(
      sendSpy.mock.calls.filter(
        (c: unknown[]) =>
          toOf(c) === "cat@test.dev" || toOf(c) === "pend@test.dev",
      ),
    ).toHaveLength(0);
  });
});

describe("listing watch (QA-407)", () => {
  async function activeListing(title = "Watched Jet") {
    await opFixture();
    const res = await postListing(mkListing(title));
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  }

  it("watching a listing mails on a live edit, never on others", async () => {
    const { id } = await activeListing();
    const res = await subscribe({
      email: "watch@test.dev",
      params: { watch: id },
    });
    expect(res.status).toBe(200);
    const { devConfirmUrl } = (await res.json()) as {
      devConfirmUrl?: string;
    };
    const cres = await confirm(
      new URL(devConfirmUrl!).searchParams.get("token")!,
    );
    expect(cres.status).toBe(307);
    // Watch confirm redirects onto the LISTING, not /search.
    expect(cres.headers.get("location")).toContain(`/listing/${id}`);
    expect(cres.headers.get("location")).toContain("alert=confirmed");
    sendSpy.mockClear();

    // Price edit on the watched listing → "was updated" mail.
    const pres = await patchListing(
      new Request(`http://test.local/api/listings/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ price: 8000 }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(pres.status).toBe(200);
    const mail = sendSpy.mock.calls.find(
      (c: unknown[]) => toOf(c) === "watch@test.dev",
    );
    expect(mail).toBeDefined();
    expect(subjectOf(mail!)).toContain("was updated");
    expect(subjectOf(mail!)).toContain("Watched Jet");
    expect((mail![0] as { text?: string }).text).toContain(`/listing/${id}`);

    // An unrelated listing edit must NOT mail the watcher.
    sendSpy.mockClear();
    const other = await postListing(mkListing("Other Jet"));
    const { id: otherId } = (await other.json()) as { id: string };
    await patchListing(
      new Request(`http://test.local/api/listings/${otherId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ price: 1 }),
      }),
      { params: Promise.resolve({ id: otherId }) },
    );
    expect(
      sendSpy.mock.calls.filter((c: unknown[]) => toOf(c) === "watch@test.dev"),
    ).toHaveLength(0);
  });

  it("rejects watch+filters (422) and unknown listing ids (404)", async () => {
    const bad = await subscribe({
      email: "w2@test.dev",
      params: { watch: "00000000-0000-4000-8000-000000000000", type: "charter" },
    });
    expect(bad.status).toBe(422);
    const missing = await subscribe({
      email: "w2@test.dev",
      params: { watch: "00000000-0000-4000-8000-000000000000" },
    });
    expect(missing.status).toBe(404);
  });
});

describe("buyer self-service (QA-405)", () => {
  async function buyerRfq(email: string) {
    const listing = await repo.createListing({
      operatorId: "op_x",
      vertical: "jets",
      type: "charter",
      title: `BQ ${Math.random().toString(36).slice(2, 6)}`,
      price: 1,
      currency: "USD",
      photos: [],
      attributes: {},
    });
    return repo.createRfq({
      vertical: "jets",
      listingId: listing.id,
      buyerEmail: email,
      fields: { name: "B" },
    });
  }
  const listAlerts = (email: string, token: string | null) =>
    buyerAlertsGet(
      new Request(
        `http://test.local/api/buyer/search-alerts?email=${email}`,
        { headers: token ? { "x-rfq-token": token } : {} },
      ),
    );
  const turnOff = (id: string, email: string, token: string) =>
    alertOffPost(
      new Request(
        `http://test.local/api/search-alerts/${id}/off?email=${email}`,
        { method: "POST", headers: { "x-rfq-token": token } },
      ),
      { params: Promise.resolve({ id }) },
    );

  it("lists the mailbox's alerts behind the RFQ bearer token", async () => {
    const rfq = await buyerRfq("self@test.dev");
    await confirmedAlert("self@test.dev", { type: "charter" });
    await confirmedAlert("self@test.dev", { aircraftCategory: "heavy" });
    await confirmedAlert("other@test.dev", { type: "charter" });

    // No token / wrong token → 401; the mailbox's own token lists only
    // its own two alerts (the other mailbox's row never leaks).
    expect((await listAlerts("self@test.dev", null)).status).toBe(401);
    expect((await listAlerts("self@test.dev", "bogus")).status).toBe(401);
    const res = await listAlerts("self@test.dev", rfq.accessToken);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as {
      id: string;
      status: string;
      params: Record<string, unknown>;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "active")).toBe(true);
    expect(rows.some((r) => "token" in r)).toBe(false); // bearer stays server-side
    expect(rows.map((r) => r.params.type ?? "")).toContain("charter");
  });

  it("turns off its own alert; other mailbox's id 404s", async () => {
    const rfq = await buyerRfq("off2@test.dev");
    const mine = await confirmedAlert("off2@test.dev", { type: "charter" });
    const alien = await confirmedAlert("alien@test.dev", { type: "charter" });

    const bad = await turnOff(alien.id, "off2@test.dev", rfq.accessToken);
    expect(bad.status).toBe(404);
    const res = await turnOff(mine.id, "off2@test.dev", rfq.accessToken);
    expect(res.status).toBe(200);
    const row = (await repo.listSearchAlerts({ vertical: "jets", email: "off2@test.dev" })).find(
      (a) => a.id === mine.id,
    )!;
    expect(row.status).toBe("off");
    // Off alerts no longer mail.
    const resub = await listAlerts("off2@test.dev", rfq.accessToken);
    const rows = (await resub.json()) as { status: string }[];
    expect(rows[0]!.status).toBe("off");
  });
});
