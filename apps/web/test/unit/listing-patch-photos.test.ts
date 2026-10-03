/**
 * PATCH /api/listings/[id] photo orphan sweep (QA-389): replacing `photos`
 * used to leave every dropped key in storage forever — operators' upload
 * dirs grew unboundedly (data-growth scoping, same class as job pruning).
 * Dropped keys are now deleted after the update, but only when none of the
 * operator's OTHER listings still references them (uploads can be shared
 * across listings). Sweep failures must not fail the PATCH.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), "jm-orphan-"));
(globalThis as { __jmStorage?: unknown }).__jmStorage = undefined;

import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { value: jar.get(name) } : undefined,
  }),
}));

import { storageProvider } from "@jetmarket/providers";
import { sessionCookie, signSession } from "../../lib/auth";
import { getMemoryRepo } from "../../lib/repo/memory";
import type { Repo } from "../../lib/repo/types";
import { PATCH as patchListing } from "../../app/api/listings/[id]/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (body: unknown) =>
  new Request("http://test.local/api", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => jar.clear());

async function fixture(repo: Repo) {
  const tag = Math.random().toString(36).slice(2, 8);
  const user = await repo.createUser(`op-${tag}@test.dev`, "operator");
  const op = await repo.upsertOperator({
    userId: user.id,
    name: `Ops ${tag}`,
    baseAirport: "ZRH",
    fleetSummary: "",
    verified: true,
    plan: "pro",
  });
  const put = async (name: string) => {
    const key = `uploads/${user.id}/${name}.png`;
    await storageProvider().put(key, new Uint8Array([1, 2, 3]), {
      contentType: "image/png",
    });
    return key;
  };
  const listing = await repo.createListing({
    operatorId: op.id,
    vertical: "jets",
    type: "charter",
    title: `Jet ${tag}`,
    price: 9000,
    currency: "USD",
    photos: [await put("a"), await put("b"), await put("c")],
    attributes: {},
  });
  return { user, op, listing };
}

describe("PATCH photos orphan sweep (QA-389)", () => {
  it("deletes dropped keys after the replace, keeps retained keys", async () => {
    const repo = await getMemoryRepo();
    const { user, listing } = await fixture(repo);
    jar.set(sessionCookie, signSession(user.id, 1));

    const [a, b, c] = listing.photos;
    const res = await patchListing(patch({ photos: [b, c] }), params(listing.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { photos: string[] };
    expect(body.photos).toEqual([b, c]);

    const storage = storageProvider();
    expect(await storage.get(a!)).toBeNull();
    expect(await storage.get(b!)).not.toBeNull();
    expect(await storage.get(c!)).not.toBeNull();
  });

  it("keeps a dropped key still referenced by another listing of the same operator", async () => {
    const repo = await getMemoryRepo();
    const { user, op, listing } = await fixture(repo);
    jar.set(sessionCookie, signSession(user.id, 1));
    const shared = listing.photos[0]!;
    const sibling = await repo.createListing({
      operatorId: op.id,
      vertical: "jets",
      type: "charter",
      title: `Sister ${Math.random().toString(36).slice(2, 8)}`,
      price: 5000,
      currency: "USD",
      photos: [shared],
      attributes: {},
    });
    expect(sibling.photos).toEqual([shared]);

    const res = await patchListing(
      patch({ photos: [listing.photos[1]!] }),
      params(listing.id),
    );
    expect(res.status).toBe(200);

    // `shared` was dropped from `listing` but still used by `sibling`.
    expect(await storageProvider().get(shared)).not.toBeNull();
    // The other dropped key has no references — swept.
    expect(await storageProvider().get(listing.photos[2]!)).toBeNull();
  });

  it("PATCHes that don't touch photos never sweep", async () => {
    const repo = await getMemoryRepo();
    const { user, listing } = await fixture(repo);
    jar.set(sessionCookie, signSession(user.id, 1));

    const res = await patchListing(patch({ title: "Renamed" }), params(listing.id));
    expect(res.status).toBe(200);
    for (const key of listing.photos) {
      expect(await storageProvider().get(key)).not.toBeNull();
    }
  });
});
