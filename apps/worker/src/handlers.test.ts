import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { EmailMessage } from "@jetmarket/providers/email/index";
import { defaultPlans } from "@jetmarket/domain";
import {
  deliverDueMatches,
  recoverUnfanoutedRfqs,
  handleJob,
  notifyExpirations,
  rfqFanout,
} from "./handlers";
import type { WorkerDeps } from "./handlers";
import type { WorkerRepo } from "./repo";
import { machineryVertical, rfqFieldLabels } from "@jetmarket/verticals";
import en from "@jetmarket/i18n/messages/en.json";

function fakeRepo(over: Partial<WorkerRepo> = {}): WorkerRepo & {
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {};
  const rec = (k: string, v: unknown) => (calls[k] ??= []).push(v);
  return {
    calls,
    loadRfq: async (id) => {
      rec("loadRfq", id);
      return {
        id,
        vertical: "jets",
        status: "new",
        listingId: null,
        ownerOperatorId: null,
        listingAttributes: null,
        fields: {
          departure: "ZRH",
          arrival: "NCE",
          passengers: 6,
          dateFrom: "2026-10-01",
          dateTo: "2026-10-01",
          email: "buyer@x.com",
        },
      };
    },
    loadOperatorCandidates: async (v) => {
      rec("loadOperatorCandidates", v);
      return [
        {
          id: "op1",
          verified: true,
          planId: "pro",
          baseAirport: "ZRH",
          fleet: [{ listingId: "l1", category: "light", seats: 8 }],
        },
        {
          id: "op2",
          verified: false,
          planId: "free",
          baseAirport: "HAM",
          fleet: [{ listingId: "l2", category: "mid", seats: 8 }],
        },
      ];
    },
    insertMatches: async (rows) => {
      rec("insertMatches", rows);
      return rows.map((r, i) => ({ id: `m${i}`, state: r.state }));
    },
    markRfqMatched: async (id) => {
      rec("markRfqMatched", id);
    },
    expireRfqs: async (now) => {
      rec("expireRfqs", now);
      return { rfqs: [], quotes: [] };
    },
    loadOperatorEmails: async (ids) => {
      rec("loadOperatorEmails", ids);
      return ids.map((operatorId) => ({
        operatorId,
        email: `owner-${operatorId}@ops.example`,
      }));
    },
    deliverDueMatches: async (now) => {
      rec("deliverDueMatches", now);
      return ["m-due-1", "m-due-2"];
    },
    unnotifiedPendingMatches: async () => {
      rec("unnotifiedPendingMatches", undefined);
      return [];
    },
    unfanoutedRfqs: async (olderThan, limit) => {
      rec("unfanoutedRfqs", { olderThan, limit });
      return [];
    },
    loadMatchContext: async (id) => {
      rec("loadMatchContext", id);
      return {
        matchId: id,
        rfqId: "r1",
        state: "pending",
        rfqStatus: "new",
        operatorEmail: "ops@alpinejet.example",
        operatorName: "Alpine Jet",
        rfqFields: { departure: "ZRH", arrival: "NCE", passengers: 6 },
        buyerEmail: "buyer@x.com",
        listingTitle: "Phenom 300 charter",
      };
    },
    markMatchState: async (id, s) => {
      rec("markMatchState", [id, s]);
    },
    ...over,
  };
}

const sent: EmailMessage[] = [];
const deps = (repo: WorkerRepo): WorkerDeps => ({
  repo,
  sql: {} as Sql, // enqueueJob is stubbed via sql.unsafe below in unit tests
  vertical: "jets",
  email: {
    send: async (m) => {
      sent.push(m);
      return { id: "e1", to: m.to, subject: m.subject, at: "t" };
    },
  },
  plans: defaultPlans(),
  now: () => new Date("2026-09-15T12:00:00Z"),
});

// enqueueJob hits the real sql client — for unit tests swap it for a no-op
// by giving deps.sql a tagged-template callable.
function sqlStub(enqueued: { kind: string; payload: unknown }[]) {
  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    enqueued.push({
      kind: String(vals[0]),
      payload: JSON.parse(String(vals[1])),
    });
    return Promise.resolve([{ id: "job-1" }]);
  }) as unknown as Sql;
  return sql;
}

describe("rfqFanout", () => {
  it("writes matches (instant for verified+pro) and marks rfq matched", async () => {
    const repo = fakeRepo();
    const enqueued: { kind: string; payload: unknown }[] = [];
    const d = deps(repo);
    d.sql = sqlStub(enqueued);

    await rfqFanout(d, { rfqId: "r1" });

    const rows = repo.calls["insertMatches"]![0] as {
      operatorId: string;
      state: string;
    }[];
    expect(rows).toHaveLength(2);
    const op1 = rows.find((r) => r.operatorId === "op1")!;
    const op2 = rows.find((r) => r.operatorId === "op2")!;
    // pro+verified -> instant/pending; free+unverified -> delayed
    expect(op1.state).toBe("pending");
    expect(op2.state).toBe("delayed");
    expect(repo.calls["markRfqMatched"]).toEqual(["r1"]);
    // only the instant match enqueues a notification
    expect(enqueued).toEqual([
      { kind: "email.quote_notification", payload: { matchId: "m0" } },
    ]);
  });

  it("infers the category from the listing and filters fleets by it (QA-229)", async () => {
    const repo = fakeRepo({
      loadRfq: async (id) => ({
        id,
        vertical: "machinery",
        status: "new",
        listingId: "l-x",
        ownerOperatorId: null,
        listingAttributes: { machineryCategory: "lathe" },
        fields: { email: "buyer@x.com" }, // no category field on the form
      }),
      loadOperatorCandidates: async () => [
        {
          id: "lathe-dealer",
          verified: true,
          planId: "pro",
          fleet: [{ listingId: "a", category: "lathe" }],
        },
        {
          id: "press-dealer",
          verified: true,
          planId: "pro",
          fleet: [{ listingId: "b", category: "press" }],
        },
        {
          // No category-bearing stock — cannot prove fit, skipped.
          id: "bare-dealer",
          verified: true,
          planId: "pro",
          fleet: [{ listingId: "c" }],
        },
      ],
    });
    const d = deps(repo);
    d.matching = {
      categoryAttribute: "machineryCategory",
      rfqCategoryKeys: ["machineryCategory"],
    };
    d.sql = sqlStub([]);

    await rfqFanout(d, { rfqId: "r1" });

    const rows = repo.calls["insertMatches"]![0] as {
      operatorId: string;
    }[];
    expect(rows.map((r) => r.operatorId)).toEqual(["lathe-dealer"]);
  });

  it("honours vertical rfqCategoryKeys on the fields themselves (QA-229)", async () => {
    const repo = fakeRepo({
      loadRfq: async (id) => ({
        id,
        vertical: "machinery",
        status: "new",
        listingId: null,
        ownerOperatorId: null,
        listingAttributes: null,
        fields: { machineryCategory: "press", email: "buyer@x.com" },
      }),
      loadOperatorCandidates: async () => [
        {
          id: "lathe-dealer",
          verified: true,
          planId: "pro",
          fleet: [{ listingId: "a", category: "lathe" }],
        },
        {
          id: "press-dealer",
          verified: true,
          planId: "pro",
          fleet: [{ listingId: "b", category: "press" }],
        },
      ],
    });
    const d = deps(repo);
    d.matching = {
      categoryAttribute: "machineryCategory",
      rfqCategoryKeys: ["machineryCategory"],
    };
    d.sql = sqlStub([]);

    await rfqFanout(d, { rfqId: "r1" });

    const rows = repo.calls["insertMatches"]![0] as {
      operatorId: string;
    }[];
    expect(rows.map((r) => r.operatorId)).toEqual(["press-dealer"]);
  });

  it("no-ops on a non-new rfq (closed/expired/already-matched)", async () => {
    const repo = fakeRepo({ loadRfq: async (id) => ({
      id,
      vertical: "jets",
      status: "closed",
      listingId: null,
      ownerOperatorId: null,
      listingAttributes: null,
      fields: {},
    }) });
    const d = deps(repo);
    await rfqFanout(d, { rfqId: "r1" });
    expect(repo.calls["insertMatches"]).toBeUndefined();
    expect(repo.calls["markRfqMatched"]).toBeUndefined();
  });

  it("rejects a malformed payload", async () => {
    await expect(rfqFanout(deps(fakeRepo()), {})).rejects.toThrow(/rfqId/);
  });
});

describe("deliverDueMatches", () => {
  it("flips due matches and enqueues notifications", async () => {
    const enqueued: { kind: string; payload: unknown }[] = [];
    const d = deps(fakeRepo());
    d.sql = sqlStub(enqueued);
    const n = await deliverDueMatches(d);
    expect(n).toBe(2);
    expect(enqueued.map((e) => e.kind)).toEqual([
      "email.quote_notification",
      "email.quote_notification",
    ]);
  });

  it("re-enqueues stranded pending matches (crash window), deduped (QA-162)", async () => {
    const enqueued: { kind: string; payload: unknown }[] = [];
    const repo = fakeRepo({
      // m-due-1 was flipped this tick AND is stranded (job not yet enqueued
      // when the scan ran) — Set dedup must enqueue it exactly once.
      unnotifiedPendingMatches: async () => ["m-due-1", "m-stranded-9"],
    });
    const d = deps(repo);
    d.sql = sqlStub(enqueued);
    const n = await deliverDueMatches(d);
    expect(n).toBe(3);
    expect(
      enqueued.map((e) => (e.payload as { matchId: string }).matchId),
    ).toEqual(["m-due-1", "m-due-2", "m-stranded-9"]);
  });
});

describe("recoverUnfanoutedRfqs", () => {
  it("re-enqueues rfq.fanout for persisted RFQs whose job never landed (QA-168)", async () => {
    const enqueued: { kind: string; payload: unknown }[] = [];
    const repo = fakeRepo({
      unfanoutedRfqs: async () => ["r-stuck-1", "r-stuck-2"],
    });
    const d = deps(repo);
    d.sql = sqlStub(enqueued);
    const n = await recoverUnfanoutedRfqs(d);
    expect(n).toBe(2);
    expect(enqueued.map((e) => e.kind)).toEqual([
      "rfq.fanout",
      "rfq.fanout",
    ]);
    expect(
      enqueued.map((e) => (e.payload as { rfqId: string }).rfqId),
    ).toEqual(["r-stuck-1", "r-stuck-2"]);
  });

  it("passes a grace window so an in-flight persist→enqueue isn't re-enqueued", async () => {
    const seen: { olderThan?: Date } = {};
    const repo = fakeRepo({
      unfanoutedRfqs: async (olderThan) => {
        seen.olderThan = olderThan;
        return [];
      },
    });
    // The stubbed clock sits at 2026-09-15T12:00:00Z (see deps()).
    const now = new Date("2026-09-15T12:00:00Z").getTime();
    const n = await recoverUnfanoutedRfqs(deps(repo));
    expect(n).toBe(0);
    // ~2 min grace — anything newer might still be inside the route's
    // own persist→enqueue sequence.
    expect(now - seen.olderThan!.getTime()).toBe(120_000);
  });
});

describe("handleJob dispatch", () => {
  it("sends the quote-notification email and marks the match sent", async () => {
    const repo = fakeRepo();
    sent.length = 0;
    await handleJob(deps(repo), "email.quote_notification", {
      matchId: "m9",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ops@alpinejet.example");
    expect(sent[0]!.subject).toContain("ZRH");
    expect(repo.calls["markMatchState"]).toEqual([["m9", "sent"]]);
  });

  it("renders the machinery RFQ body with field labels, not a jets route (QA-234)", async () => {
    const repo = fakeRepo({
      loadMatchContext: async (id: string) => ({
        matchId: id,
        rfqId: "r1",
        state: "pending",
        rfqStatus: "new",
        operatorEmail: "ops@alpine.example",
        operatorName: "Alpine Werkzeug",
        rfqFields: {
          deliveryPostcode: "80331",
          budgetEur: 45000,
          name: "Ada Lovelace",
          email: "ada@x.com",
          phone: "+49 0000",
        },
        buyerEmail: "ada@x.com",
        listingTitle: "Okuma LB-EX II lathe",
      }),
    });
    sent.length = 0;
    const labels = rfqFieldLabels(
      machineryVertical,
      (en.vertical as { machinery: Record<string, unknown> }).machinery,
    );
    await handleJob({ ...deps(repo), fieldLabels: labels },
      "email.quote_notification",
      { matchId: "m9" },
    );
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.subject).toContain("Okuma LB-EX II lathe");
    expect(mail.text).toContain("Delivery postcode: 80331");
    expect(mail.text).toContain("Budget (EUR): 45000");
    expect(mail.text).toContain("Buyer: Ada Lovelace");
    // No jets-shaped leftovers; contact fields stay masked until a deal.
    expect(mail.text).not.toContain("Route:");
    expect(mail.text).not.toContain("ada@x.com");
    expect(mail.text).not.toContain("+49 0000");
  });

  it("skips the send when the match is already sent (retry dedup, QA-161)", async () => {
    const repo = fakeRepo({
      loadMatchContext: async (id: string) => ({
        matchId: id,
        rfqId: "r1",
        state: "sent",
        rfqStatus: "new",
        operatorEmail: "ops@alpinejet.example",
        operatorName: "Alpine Jet",
        rfqFields: {},
        buyerEmail: "buyer@x.com",
        listingTitle: null,
      }),
    });
    sent.length = 0;
    await handleJob(deps(repo), "email.quote_notification", {
      matchId: "m9",
    });
    expect(sent).toHaveLength(0);
    expect(repo.calls["markMatchState"]).toBeUndefined();
  });

  it("skips the send when the parent RFQ closed after delivery (QA-169)", async () => {
    const repo = fakeRepo({
      loadMatchContext: async (id: string) => ({
        matchId: id,
        rfqId: "r1",
        state: "pending",
        rfqStatus: "closed",
        operatorEmail: "ops@alpinejet.example",
        operatorName: "Alpine Jet",
        rfqFields: {},
        buyerEmail: "buyer@x.com",
        listingTitle: null,
      }),
    });
    sent.length = 0;
    // Completes without throwing — the job is done, not retryable.
    await handleJob(deps(repo), "email.quote_notification", {
      matchId: "m9",
    });
    expect(sent).toHaveLength(0);
    expect(repo.calls["markMatchState"]).toBeUndefined();
  });

  it("throws on unknown job kinds", async () => {
    await expect(
      handleJob(deps(fakeRepo()), "bogus", {}),
    ).rejects.toThrow(/unknown job kind/);
  });
});

describe("notifyExpirations", () => {
  it("emails each expired buyer and each declined-quote operator", async () => {
    const repo = fakeRepo();
    sent.length = 0;
    await notifyExpirations(deps(repo), {
      rfqs: [
        { id: "r1", buyerEmail: "buyer@x.com", listingTitle: "G650 charter" },
      ],
      quotes: [
        {
          id: "q1",
          rfqId: "r1",
          operatorId: "op1",
          amountMinor: 42000_00,
          currency: "USD",
          listingTitle: "G650 charter",
        },
        {
          id: "q2",
          rfqId: "r1",
          operatorId: "op2",
          amountMinor: 44000_00,
          currency: "USD",
          listingTitle: "G650 charter",
        },
      ],
    });
    expect(sent.map((m) => m.to)).toEqual([
      "buyer@x.com",
      "owner-op1@ops.example",
      "owner-op2@ops.example",
    ]);
    expect(sent[0]!.subject).toContain("expired");
    // one batched contact lookup, deduped operator ids
    expect(repo.calls["loadOperatorEmails"]).toEqual([["op1", "op2"]]);
  });

  it("emits rfq_expired/quote_expired analytics when a sink is wired (QA-189)", async () => {
    const repo = fakeRepo();
    sent.length = 0;
    const events: { name: string; props?: Record<string, unknown> }[] = [];
    const d = deps(repo);
    d.analytics = { track: (e) => void events.push(e) };
    await notifyExpirations(d, {
      rfqs: [
        { id: "r9", buyerEmail: "buyer@x.com", listingTitle: "G650" },
      ],
      quotes: [
        {
          id: "q9",
          rfqId: "r9",
          operatorId: "op1",
          amountMinor: 100_00,
          currency: "USD",
          listingTitle: "G650",
        },
      ],
    });
    expect(events.map((e) => e.name)).toEqual(["rfq_expired", "quote_expired"]);
    expect(events[0]!.props?.rfqId).toBe("r9");
    expect(events[1]!.props?.quoteId).toBe("q9");
  });

  it("a bad address does not stop the rest of the sweep", async () => {
    const repo = fakeRepo();
    sent.length = 0;
    const d = deps(repo);
    d.email = {
      send: async (m) => {
        if (m.to === "buyer@x.com") throw new Error("smtp rejected");
        sent.push(m);
        return { id: "e1", to: m.to, subject: m.subject, at: "t" };
      },
    };
    await notifyExpirations(d, {
      rfqs: [
        { id: "r1", buyerEmail: "buyer@x.com", listingTitle: null },
        { id: "r2", buyerEmail: "buyer2@x.com", listingTitle: null },
      ],
      quotes: [],
    });
    expect(sent.map((m) => m.to)).toEqual(["buyer2@x.com"]);
  });
});
