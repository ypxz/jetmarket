import { describe, expect, it } from "vitest";
import { jetsVertical, machineryVertical } from "@jetmarket/verticals";
import { operatorRfqView } from "@/lib/rfq-view";
import { attrsFor, optionLabelKey } from "@/lib/attrs";
import { readJson, readJsonOr } from "@/lib/fetch-json";
import {
  invoiceStateVariant,
  jobStateVariant,
  quoteStateVariant,
  rfqStateVariant,
} from "@/lib/state-variant";
import type { Rfq } from "@/lib/repo/types";

const rfq: Rfq = {
  id: "r1",
  vertical: "jets",
  listingId: "l1",
  buyerEmail: "buyer@example.com",
  accessToken: "secret-token",
  concierge: false,
  fields: {
    name: "Buyer Person",
    email: "buyer@example.com",
    phone: "+41 79 000 00 00",
    departure: "ZRH",
    arrival: "NCE",
    date: "2026-10-01",
    passengers: "4",
    notes: "flexible",
  },
  status: "open",
  createdAt: new Date().toISOString(),
};

describe("operatorRfqView — contact masking (QA-152)", () => {
  it("strips email/tel-typed fields and never exposes buyerEmail/accessToken", () => {
    const view = operatorRfqView(rfq, "charter", jetsVertical);
    expect(view.fields.email).toBeUndefined();
    expect(view.fields.phone).toBeUndefined();
    expect(view.fields.departure).toBe("ZRH");
    expect(view.fields.passengers).toBe("4");
    // the masked view must not carry the bearer token or raw buyer email —
    // either one would let an operator self-accept or bypass the fee
    expect(Object.keys(view)).not.toContain("buyerEmail");
    expect(Object.keys(view)).not.toContain("accessToken");
    expect(JSON.stringify(view)).not.toContain("secret-token");
  });

  it("masks whichever contact fields the vertical declares (machinery parity)", () => {
    const contactKeys = machineryVertical.rfqFields
      .filter((f) => f.type === "email" || f.type === "tel")
      .map((f) => f.key);
    expect(contactKeys.length).toBeGreaterThan(0);
    const fields = Object.fromEntries([
      ...contactKeys.map((k) => [k, `secret-${k}`]),
      ["notes", "ok"],
    ]);
    const view = operatorRfqView(
      { ...rfq, fields },
      machineryVertical.rfqFields[0]!.appliesTo?.[0],
      machineryVertical,
    );
    for (const k of contactKeys) expect(view.fields[k]).toBeUndefined();
    expect(view.fields.notes).toBe("ok");
  });
});

describe("attrsFor / optionLabelKey", () => {
  it("scopes attribute schemas to the listing type", () => {
    const all = attrsFor(jetsVertical, "charter");
    for (const a of all) expect(a.appliesTo).toContain("charter");
    // empty_leg-only attributes must not leak into a charter form
    const legOnly = jetsVertical.attributes.filter(
      (a) => !a.appliesTo.includes("charter"),
    );
    for (const a of legOnly) expect(all.map((x) => x.key)).not.toContain(a.key);
  });

  it("resolves enum option label keys via the owning facet", () => {
    const attr = jetsVertical.attributes.find((a) =>
      jetsVertical.facets.some(
        (f) => f.type === "enum" && f.attributeKey === a.key,
      ),
    )!;
    const facet = jetsVertical.facets.find(
      (f) => f.type === "enum" && f.attributeKey === attr.key,
    )!;
    const opt = facet.options![0]!;
    expect(optionLabelKey(jetsVertical, attr, opt.value)).toBe(opt.labelKey);
    expect(optionLabelKey(jetsVertical, attr, "nope")).toBeUndefined();
  });
});

describe("readJson / readJsonOr", () => {
  it("throws a descriptive error on non-JSON bodies", async () => {
    const res = new Response("<html>bad gateway</html>", { status: 502 });
    await expect(readJson(res)).rejects.toThrow(/non-JSON response \(502\)/);
  });
  it("returns {} for empty bodies and parses JSON", async () => {
    await expect(readJson(new Response(""))).resolves.toEqual({});
    await expect(
      readJson(new Response('{"a":1}')),
    ).resolves.toEqual({ a: 1 });
  });
  it("readJsonOr falls back instead of throwing", async () => {
    const res = new Response("<html/>", { status: 500 });
    await expect(readJsonOr(res, { ok: false })).resolves.toEqual({
      ok: false,
    });
  });
});

describe("state-variant mappings", () => {
  it("maps every status to a badge variant (exhaustiveness pin)", () => {
    for (const s of ["sent", "accepted", "declined", "withdrawn"] as const)
      expect(quoteStateVariant(s)).toBeTruthy();
    for (const s of [
      "open",
      "matched",
      "quoted",
      "closed",
      "expired",
      "spam",
    ] as const)
      expect(rfqStateVariant(s)).toBeTruthy();
    for (const s of ["pending", "invoiced", "paid", "void"] as const)
      expect(invoiceStateVariant(s)).toBeTruthy();
    for (const s of ["done", "failed", "running", "pending"] as const)
      expect(jobStateVariant(s)).toBeTruthy();
  });
});
