/**
 * QA-108 — server-side session revocation: logout bumps
 * users.session_version, so any outstanding session cookie (including one
 * an attacker copied before logout) stops verifying against the row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { value: jar.get(name) } : undefined,
  }),
}));

import {
  consumeMagicLink,
  currentUser,
  sessionCookie,
  signMagicLink,
  signSession,
  verifySession,
} from "../../lib/auth";
import { getMemoryRepo } from "../../lib/repo/memory";
import { POST as logout } from "../../app/api/auth/logout/route";

beforeEach(() => jar.clear());

describe("session revocation", () => {
  it("logout invalidates the session even if the cookie is replayed", async () => {
    const repo = await getMemoryRepo();
    const user = await repo.createUser("victim@test.dev", "operator");
    const stolen = signSession(user.id, user.sessionVersion);
    jar.set(sessionCookie, stolen);
    expect((await currentUser())?.id).toBe(user.id);

    // Victim logs out — the route reads the cookie header on the request.
    const res = await logout(
      new Request("http://test.local/api/auth/logout", {
        method: "POST",
        headers: { cookie: `${sessionCookie}=${stolen}` },
      }),
    );
    expect(res.status).toBe(307);

    // The stolen cookie still verifies cryptographically, but the row's
    // bumped version makes currentUser reject it.
    expect(verifySession(stolen)).not.toBeNull();
    expect(await currentUser()).toBeNull();
  });

  it("cookies minted for other users/versions can't satisfy the check", async () => {
    const repo = await getMemoryRepo();
    const user = await repo.createUser("b@test.dev", "operator");
    await repo.bumpSessionVersion(user.id);
    // Session minted pre-bump: signed but stale.
    jar.set(sessionCookie, signSession(user.id, 1));
    expect(await currentUser()).toBeNull();
    // Current version works.
    jar.set(sessionCookie, signSession(user.id, 2));
    expect((await currentUser())?.id).toBe(user.id);
  });
});

describe("magic links (QA-126)", () => {
  it("are single-use — a replayed link returns null", async () => {
    const repo = await getMemoryRepo();
    const user = await repo.createUser("replay@test.dev", "operator");
    const link = signMagicLink(user.id);
    expect(consumeMagicLink(link)).toBe(user.id);
    expect(consumeMagicLink(link)).toBeNull();
  });

  it("a different valid link for the same user still works", async () => {
    const repo = await getMemoryRepo();
    const user = await repo.createUser("fresh@test.dev", "operator");
    // Distinct iat → distinct signature.
    const link = signMagicLink(user.id);
    await new Promise((r) => setTimeout(r, 2));
    const link2 = signMagicLink(user.id);
    expect(consumeMagicLink(link)).toBe(user.id);
    expect(consumeMagicLink(link2)).toBe(user.id);
  });
});
