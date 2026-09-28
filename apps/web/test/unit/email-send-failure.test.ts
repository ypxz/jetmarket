/**
 * Email-send failure surfaces (QA-353): when the provider throws, the route
 * must return a clean 502 — not an unhandled 500 (magic-link) or a false
 * "sent" success (buyer access resend).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_OUTBOX_DIR = mkdtempSync(join(tmpdir(), "jm-outbox-"));

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { emailProvider } from "@jetmarket/providers";
import { getMemoryRepo } from "../../lib/repo/memory";
import { POST as magicLink } from "../../app/api/auth/magic-link/route";
import { POST as buyerAccess } from "../../app/api/buyer/access/route";

const post = (path: string, body: unknown, ip = "10.9.9.9") =>
  new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "fly-client-ip": ip },
    body: JSON.stringify(body),
  });

afterEach(() => vi.restoreAllMocks());

describe("email send failure → 502", () => {
  it("magic-link: provider throw returns 502, not an unhandled 500", async () => {
    vi.spyOn(emailProvider(), "send").mockRejectedValue(
      new Error("smtp down"),
    );
    const res = await magicLink(
      post("/api/auth/magic-link", { email: "ml-fail@test.dev" }, "10.9.9.1"),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(String(body.error)).toContain("try again");
  });

  it("magic-link: provider ok returns sent + devLink (test env)", async () => {
    const res = await magicLink(
      post("/api/auth/magic-link", { email: "ml-ok@test.dev" }, "10.9.9.2"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(true);
    expect(body.devLink).toContain("/api/auth/callback?token=");
  });

  it("buyer/access: provider throw returns 502, not sent:true", async () => {
    const repo = await getMemoryRepo();
    await repo.createRfq({
      vertical: "jets",
      listingId: "lst_fix",
      buyerEmail: "access-fail@test.dev",
      fields: { name: "Buyer", pax: 2 },
    });
    vi.spyOn(emailProvider(), "send").mockRejectedValue(
      new Error("smtp down"),
    );
    const res = await buyerAccess(
      post("/api/buyer/access", { email: "access-fail@test.dev" }, "10.9.9.3"),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(String(body.error)).toContain("try again");
  });

  it("buyer/access: provider ok returns sent:true", async () => {
    const repo = await getMemoryRepo();
    await repo.createRfq({
      vertical: "jets",
      listingId: "lst_fix",
      buyerEmail: "access-ok@test.dev",
      fields: { name: "Buyer", pax: 2 },
    });
    const res = await buyerAccess(
      post("/api/buyer/access", { email: "access-ok@test.dev" }, "10.9.9.4"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).sent).toBe(true);
  });
});
