/**
 * Amend-mail diff (QA-482): `emailRfqAmended` leads with an
 * "old → new" field delta when the caller passes the pre-amend fields —
 * operators spot the change instead of re-reading every line. A no-op or
 * missing prev falls back to the full detail dump; buyer contact keys
 * never diff (masked pre-deal, QA-152).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { emailProvider } from "@jetmarket/providers";
import { emailRfqAmended } from "../../lib/fanout";
import { getMemoryRepo } from "../../lib/repo/memory";
import type { Repo, Rfq } from "../../lib/repo/types";

let repo: Repo;
let opId: string;
let sendSpy: ReturnType<typeof vi.spyOn>;

const rfq = (fields: Record<string, unknown>): Rfq => ({
  id: "rfq-diff",
  vertical: "jets",
  listingId: "l1",
  buyerEmail: "buyer@test.dev",
  accessToken: "tok",
  fields,
  concierge: false,
  status: "matched",
  createdAt: "2026-10-01T00:00:00.000Z",
  locale: "en",
      updatedAt: "2026-10-02T00:00:00.000Z",
});

type SentMail = { to: string; subject: string; text: string };
const sent = (): SentMail[] =>
  sendSpy.mock.calls.map((c: unknown[]) => c[0] as SentMail);

describe("emailRfqAmended — old → new diff (QA-482)", () => {
  beforeEach(async () => {
    repo = await getMemoryRepo();
    const u = await repo.createUser("op-diff@test.dev", "operator");
    const op = await repo.upsertOperator({
      userId: u.id,
      name: "Diff Air",
      baseAirport: "ZRH",
      fleetSummary: "",
      verified: true,
      plan: "pro",
    });
    opId = op.id;
    sendSpy = vi
      .spyOn(emailProvider(), "send")
      .mockResolvedValue({
        id: "m1",
        to: "x@y.z",
        subject: "s",
        at: "2026-01-01T00:00:00Z",
      });
  });

  it("leads with the changed lines only — subject carries the NEW route", async () => {
    await emailRfqAmended(
      repo,
      rfq({
        name: "B",
        email: "b@x.dev",
        departure: "GVA",
        arrival: "NCE",
        passengers: 6,
      }),
      "Charter Jet",
      [opId],
      {
        name: "B",
        email: "b@x.dev",
        departure: "ZRH",
        arrival: "NCE",
        passengers: 4,
      },
    );
    const mail = sent().find((m) => m.to === "op-diff@test.dev");
    expect(mail).toBeTruthy();
    expect(mail!.subject).toBe("Updated RFQ — GVA → NCE — Charter Jet");
    expect(mail!.text).toContain("what changed");
    expect(mail!.text).toContain("Departure: ZRH → GVA");
    expect(mail!.text).toContain("Passengers: 4 → 6");
    // Unchanged lines are NOT re-dumped — the delta is the whole story.
    expect(mail!.text).not.toContain("Arrival: NCE");
    // Contact keys never diff — masking holds even in the delta (QA-152).
    expect(mail!.text).not.toContain("b@x.dev");
  });

  it("diffs a removed field as 'old → —' and an added one as '— → new'", async () => {
    await emailRfqAmended(
      repo,
      rfq({ name: "B", departure: "ZRH", notes: "" }),
      undefined,
      [opId],
      { name: "B", departure: "ZRH", notes: "window seat" },
    );
    const mail = sent().find((m) => m.to === "op-diff@test.dev");
    expect(mail!.text).toContain("Notes for operators: window seat → —");
  });

  it("falls back to the full detail dump without prev fields", async () => {
    await emailRfqAmended(
      repo,
      rfq({ name: "B", departure: "ZRH", arrival: "NCE" }),
      "Charter Jet",
      [opId],
    );
    const mail = sent().find((m) => m.to === "op-diff@test.dev");
    expect(mail!.text).toContain("latest details");
    expect(mail!.text).toContain("Departure: ZRH");
    expect(mail!.text).toContain("Arrival: NCE");
  });
});

describe("fan-out mail mute (QA-505)", () => {
  it("an opted-out op gets no amend or new-RFQ mail; opt-in restores", async () => {
    repo = await getMemoryRepo();
    const u = await repo.createUser("mute-op@test.dev", "operator");
    const op = await repo.upsertOperator({
      userId: u.id,
      name: "Mute Air",
      baseAirport: "ZRH",
      fleetSummary: "",
      verified: true,
      plan: "pro",
    });
    sendSpy = vi
      .spyOn(emailProvider(), "send")
      .mockResolvedValue({
        id: "m1",
        to: "x@y.z",
        subject: "s",
        at: "2026-01-01T00:00:00Z",
      });

    await repo.setOperatorNotifyRfqMatch(op.id, false);
    await emailRfqAmended(repo, rfq({ name: "B", departure: "ZRH" }), "Jet", [
      op.id,
    ]);
    expect(sent().filter((m) => m.to === "mute-op@test.dev")).toHaveLength(0);

    await repo.setOperatorNotifyRfqMatch(op.id, true);
    await emailRfqAmended(repo, rfq({ name: "B", departure: "GVA" }), "Jet", [
      op.id,
    ]);
    expect(sent().filter((m) => m.to === "mute-op@test.dev")).toHaveLength(1);
  });

  it("emailRfqMatches honors the same mute", async () => {
    const { emailRfqMatches } = await import("../../lib/fanout");
    repo = await getMemoryRepo();
    const u = await repo.createUser("mute-op2@test.dev", "operator");
    const op = await repo.upsertOperator({
      userId: u.id,
      name: "Mute Air 2",
      baseAirport: "ZRH",
      fleetSummary: "",
      verified: true,
      plan: "pro",
    });
    sendSpy = vi
      .spyOn(emailProvider(), "send")
      .mockResolvedValue({
        id: "m1",
        to: "x@y.z",
        subject: "s",
        at: "2026-01-01T00:00:00Z",
      });
    await repo.setOperatorNotifyRfqMatch(op.id, false);
    await emailRfqMatches(repo, rfq({ name: "B" }), "Jet", [op.id]);
    expect(sent().filter((m) => m.to === "mute-op2@test.dev")).toHaveLength(0);
  });
});
