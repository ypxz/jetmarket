import { describe, expect, it } from "vitest";
import { MockAuthProvider } from "./mock";
import { SESSION_COOKIE_NAME } from "./types";

const auth = () =>
  new MockAuthProvider({
    secret: "test-secret",
    appUrl: "http://localhost:3000",
    now: () => new Date("2026-09-15T12:00:00Z"),
  });

describe("MockAuthProvider", () => {
  it("issues a magic link and verifies it into a session", async () => {
    const a = auth();
    const link = await a.requestMagicLink("Buyer@Example.com", {
      role: "buyer",
      redirectTo: "/quotes",
    });
    expect(link.url).toContain("token=");
    const session = await a.verifyMagicLink(link.token);
    expect(session?.email).toBe("buyer@example.com");
    expect(session?.role).toBe("buyer");
    // single-use
    expect(await a.verifyMagicLink(link.token)).toBeNull();
  });

  it("round-trips the signed session cookie and rejects tampering", async () => {
    const a = auth();
    const link = await a.requestMagicLink("op@x.com");
    const session = (await a.verifyMagicLink(link.token))!;
    const cookie = a.sessionCookieValue(session);

    const got = await a.getSession(`${SESSION_COOKIE_NAME}=${cookie}`);
    expect(got?.id).toBe(session.id);
    expect(got?.email).toBe(session.email);

    // tampered signature rejected
    expect(
      await a.getSession(`${SESSION_COOKIE_NAME}=${cookie.slice(0, -2)}00`),
    ).toBeNull();
    // wrong cookie name / missing
    expect(await a.getSession("other=x")).toBeNull();
    expect(await a.getSession(null)).toBeNull();
    expect(await a.getSession(undefined)).toBeNull();
  });

  it("expires magic links and signs sessions out", async () => {
    let t = Date.parse("2026-09-15T12:00:00Z");
    const a = new MockAuthProvider({
      secret: "s",
      now: () => new Date(t),
      linkTtlMs: 1000,
    });
    const link = await a.requestMagicLink("x@y.com");
    t += 2000; // past link ttl
    expect(await a.verifyMagicLink(link.token)).toBeNull();

    const link2 = await a.requestMagicLink("x@y.com");
    const s = (await a.verifyMagicLink(link2.token))!;
    await a.signOut(s.id);
    expect(
      await a.getSession(`${SESSION_COOKIE_NAME}=${a.sessionCookieValue(s)}`),
    ).toBeNull();
  });
});
