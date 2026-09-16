import { describe, expect, it } from "vitest";
import { MockCaptchaProvider } from "./captcha/mock";
import { TurnstileCaptchaProvider } from "./captcha/real";
import { captchaProviderName } from "./captcha";
import { MockSearchProvider } from "./search/mock";
import { searchProviderName } from "./search";
import { analyticsProviderName, createAnalyticsProvider } from "./analytics";
import { MockAnalyticsProvider } from "./analytics/mock";
import { NoopAnalyticsProvider } from "./analytics/real";
import { authProviderName } from "./auth";
import { emailProviderName } from "./email";
import { storageProviderName } from "./storage";
import { paymentsProviderName } from "./payments";
import type { SearchHit } from "./search/types";

describe("captcha", () => {
  it("mock always passes except force-fail", async () => {
    const c = new MockCaptchaProvider();
    expect((await c.verify("tok")).success).toBe(true);
    expect((await c.verify(null)).success).toBe(true);
    expect((await c.verify("force-fail")).success).toBe(false);
  });

  it("turnstile fails closed without a secret", async () => {
    const c = new TurnstileCaptchaProvider({ secretKey: "" });
    const r = await c.verify("tok");
    expect(r.success).toBe(false);
    expect(r.reason).toContain("TURNSTILE_SECRET_KEY");
  });
});

const hit = (over: Partial<SearchHit>): SearchHit => ({
  id: over.id ?? "id",
  vertical: "jets",
  type: "charter",
  title: "Phenom 300E",
  attributes: { aircraftCategory: "light", seats: 7 },
  priceMinor: 430_000,
  currency: "USD",
  status: "active",
  operatorId: "op",
  photos: [],
  ...over,
});

describe("search mock", () => {
  it("filters by vertical/type/text/filters/ranges and paginates", async () => {
    const s = new MockSearchProvider();
    s.seed([
      hit({ id: "a", title: "Phenom 300E" }),
      hit({
        id: "b",
        type: "empty_leg",
        title: "ZRH → NCE empty leg",
        attributes: { from: "ZRH" },
      }),
      hit({ id: "c", vertical: "machinery" }),
      hit({ id: "d", status: "draft" }),
    ]);
    const all = await s.search({ vertical: "jets" });
    expect(all.total).toBe(2);

    const legs = await s.search({ vertical: "jets", type: "empty_leg" });
    expect(legs.hits.map((h) => h.id)).toEqual(["b"]);

    const text = await s.search({ vertical: "jets", text: "phenom" });
    expect(text.hits.map((h) => h.id)).toEqual(["a"]);

    const seats = await s.search({
      vertical: "jets",
      ranges: { seats: { min: 5, max: 9 } },
    });
    expect(seats.hits.map((h) => h.id)).toEqual(["a"]);

    const paged = await s.search({ vertical: "jets", limit: 1, offset: 1 });
    expect(paged.hits).toHaveLength(1);
    expect(paged.total).toBe(2);
  });
});

describe("analytics", () => {
  it("mock captures; real is noop", () => {
    const m = new MockAnalyticsProvider({ log: false });
    m.track({ name: "rfq.sent", props: { rfqId: "r1" } });
    expect(m.events).toHaveLength(1);
    expect(m.events[0]!.at).toBeTruthy();
    const noop: import("./analytics/types").AnalyticsProvider =
      new NoopAnalyticsProvider();
    expect(() => noop.track({ name: "x" })).not.toThrow();
    expect(createAnalyticsProvider({ ANALYTICS_PROVIDER: "real" })).toBeInstanceOf(
      NoopAnalyticsProvider,
    );
  });
});

describe("env selection", () => {
  it("maps *_PROVIDER env vars to impl names with mock-safe defaults", () => {
    expect(authProviderName({})).toBe("mock");
    expect(authProviderName({ AUTH_PROVIDER: "supabase" })).toBe("supabase");
    expect(emailProviderName({ EMAIL_PROVIDER: "smtp" })).toBe("smtp");
    expect(emailProviderName({})).toBe("mock");
    expect(storageProviderName({ STORAGE_PROVIDER: "s3" })).toBe("s3");
    expect(paymentsProviderName({ PAYMENTS_PROVIDER: "stripe" })).toBe("stripe");
    expect(captchaProviderName({ CAPTCHA_PROVIDER: "turnstile" })).toBe(
      "turnstile",
    );
    expect(searchProviderName({})).toBe("postgres");
    expect(searchProviderName({ SEARCH_PROVIDER: "mock" })).toBe("mock");
    expect(analyticsProviderName({})).toBe("mock");
    expect(analyticsProviderName({ ANALYTICS_PROVIDER: "real" })).toBe("real");
  });
});

describe("email From defaulting (QA-21)", () => {
  it("fills From from EMAIL_FROM, else the site contact; per-message wins", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createEmailProvider } = await import("./email/index");
    const { readOutbox } = await import("./email/mock");

    const emlFrom = (dir: string, id: string) =>
      readFileSync(join(dir, `${id}.eml`), "utf8").split("\r\n")[0];

    // no EMAIL_FROM anywhere -> site contact
    const dir1 = mkdtempSync(join(tmpdir(), "jm-mail-from-"));
    const p1 = createEmailProvider({ EMAIL_PROVIDER: "mock", EMAIL_OUTBOX_DIR: dir1 });
    const s1 = await p1.send({ to: "a@b.c", subject: "s", text: "t" });
    expect(emlFrom(dir1, s1.id)).toBe("From: JetMarket <noreply@jetmarket.local>");
    expect(readOutbox(dir1)[0]!.from).toBe("JetMarket <noreply@jetmarket.local>");

    // EMAIL_FROM wins when the message has none
    const dir2 = mkdtempSync(join(tmpdir(), "jm-mail-from-"));
    const p2 = createEmailProvider({
      EMAIL_PROVIDER: "mock",
      EMAIL_OUTBOX_DIR: dir2,
      EMAIL_FROM: "Ops <ops@jetmarket.local>",
    });
    const s2 = await p2.send({ to: "a@b.c", subject: "s", text: "t" });
    expect(emlFrom(dir2, s2.id)).toBe("From: Ops <ops@jetmarket.local>");

    // per-message from overrides both
    const s3 = await p2.send({
      to: "a@b.c",
      subject: "s",
      text: "t",
      from: "Caller <caller@x.dev>",
    });
    expect(emlFrom(dir2, s3.id)).toBe("From: Caller <caller@x.dev>");
  });
});
