import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { EmailMessage } from "@jetmarket/providers/email/index";
import { defaultPlans } from "@jetmarket/domain";
import {
  deliverDueMatches,
  recoverUnfanoutedRfqs,
  handleJob,
  notifyExpiredListings,
  notifyExpirations,
  nudgeStaleQuotes,
  nudgeUnansweredOperators,
  nudgeUnquotedRfqs,
  remindOverdueInvoices,
  rfqFanout,
  searchAlertFlush,
} from "./handlers";
import type { WorkerDeps } from "./handlers";
import type { WorkerRepo } from "./repo";
import { machineryVertical, rfqFieldLabels } from "@jetmarket/verticals";
import en from "@jetmarket/i18n/messages/en.json";

// Fixture RFQ windows stay in the future — a stale window is dead input the
// sweeps would legitimately expire (QA-360).
const isoIn = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

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
        concierge: false,
        fields: {
          departure: "ZRH",
          arrival: "NCE",
          passengers: 6,
          dateFrom: isoIn(14),
          dateTo: isoIn(14),
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
        rfqConcierge: false,
        listingTitle: "Phenom 300 charter",
      };
    },
    markMatchState: async (id, s) => {
      rec("markMatchState", [id, s]);
    },
    alertBacklogs: async (v, olderThan) => {
      rec("alertBacklogs", { vertical: v, olderThan });
      return [];
    },
    loadDigestListings: async (ids, v) => {
      rec("loadDigestListings", { ids, vertical: v });
      return [];
    },
    markSearchAlerted: async (id) => {
      rec("markSearchAlerted", id);
    },
    sweepExpiredListings: async (input) => {
      rec("sweepExpiredListings", input);
      return [];
    },
    sweepStaleQuotes: async (input) => {
      rec("sweepStaleQuotes", input);
      return [];
    },
    sweepUnquotedRfqs: async (input) => {
      rec("sweepUnquotedRfqs", input);
      return [];
    },
    sweepUnansweredOperators: async (input) => {
      rec("sweepUnansweredOperators", input);
      return [];
    },
    sweepOverdueInvoices: async (input) => {
      rec("sweepOverdueInvoices", input);
      return [];
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

  it("concierge RFQ delivers EVERY match instantly — even free/unverified (QA-399)", async () => {
    // The buyer paid before this job was claimed: the flag on the row, not
    // the operator's plan, decides "instant" at fan-out time.
    const repo = fakeRepo({
      loadRfq: async (id) => ({
        ...(await fakeRepo().loadRfq(id))!,
        concierge: true,
      }),
    });
    const enqueued: { kind: string; payload: unknown }[] = [];
    const d = deps(repo);
    d.sql = sqlStub(enqueued);

    await rfqFanout(d, { rfqId: "r1" });

    const rows = repo.calls["insertMatches"]![0] as {
      operatorId: string;
      state: string;
    }[];
    expect(rows.map((r) => r.state)).toEqual(["pending", "pending"]);
    // Every match notifies — the free op isn't waiting the 24h delay.
    expect(enqueued.map((e) => e.kind)).toEqual([
      "email.quote_notification",
      "email.quote_notification",
    ]);
    expect(repo.calls["markRfqMatched"]).toEqual(["r1"]);
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
        concierge: false,
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
        concierge: false,
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
      concierge: false,
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

describe("searchAlertFlush", () => {
  it("mails one digest for matured backlogs and clears the queue (QA-403)", async () => {
    sent.length = 0;
    const repo = fakeRepo({
      alertBacklogs: async () => [
        {
          id: "a1",
          email: "buyer@x.com",
          params: { type: "charter" },
          token: "tok-a1",
          pendingIds: ["l1", "l2", "l-gone"],
        },
      ],
      loadDigestListings: async () => [
        { id: "l1", title: "Phenom 300", status: "active" },
        { id: "l2", title: "Citation CJ4", status: "active" },
        // l-gone never returns — delisted rows drop out of the digest.
      ],
    });
    const n = await searchAlertFlush(deps(repo));
    expect(n).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("buyer@x.com");
    expect(sent[0]!.subject).toContain("2 new listings");
    expect(sent[0]!.text).toContain("Phenom 300");
    expect(sent[0]!.text).toContain("unsubscribe?token=tok-a1");
    expect(repo.calls["markSearchAlerted"]).toEqual(["a1"]);
  });

  it("clears a fully-delisted backlog silently; a send failure keeps it queued", async () => {
    sent.length = 0;
    const repo = fakeRepo({
      alertBacklogs: async () => [
        { id: "a-dead", email: "x@x.com", params: {}, token: "t1", pendingIds: ["l1"] },
        { id: "a-fail", email: "y@y.com", params: {}, token: "t2", pendingIds: ["l2"] },
      ],
      loadDigestListings: async (ids) =>
        (ids as string[]).includes("l1")
          ? [{ id: "l1", title: "Gone Jet", status: "archived" }]
          : [{ id: "l2", title: "Live Jet", status: "active" }],
    });
    const d = deps(repo);
    const realSend = d.email.send;
    d.email.send = async (m) => {
      if (m.to === "y@y.com") throw new Error("smtp rejected");
      return realSend(m);
    };
    const n = await searchAlertFlush(d);
    expect(n).toBe(0);
    expect(sent).toHaveLength(0);
    // a-dead cleared without mail; a-fail stays queued (mark skipped).
    expect(repo.calls["markSearchAlerted"]).toEqual(["a-dead"]);
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
        rfqConcierge: false,
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
    // Not concierge — no paid-priority line.
    expect(mail.text).not.toContain("Priority request");
  });

  it("masks renamed contact keys when contactKeys is configured (QA-308)", async () => {
    const repo = fakeRepo({
      loadMatchContext: async (id: string) => ({
        matchId: id,
        rfqId: "r1",
        state: "pending",
        rfqStatus: "new",
        operatorEmail: "ops@alpine.example",
        operatorName: "Alpine",
        rfqFields: {
          buyerMail: "secret@buyer.example",
          buyerTel: "+00 111",
          budgetEur: 1000,
        },
        buyerEmail: "secret@buyer.example",
        rfqConcierge: false,
        listingTitle: "Lathe",
      }),
    });
    sent.length = 0;
    // Vertical renames its contact fields — only the configured set masks.
    await handleJob(
      { ...deps(repo), contactKeys: new Set(["buyerMail", "buyerTel"]) },
      "email.quote_notification",
      { matchId: "m10" },
    );
    const mail = sent[0]!;
    expect(mail.text).toContain("budgetEur: 1000"); // raw key, no fieldLabels
    expect(mail.text).not.toContain("secret@buyer.example");
    expect(mail.text).not.toContain("+00 111");
  });

  it("flags concierge expedites — operators see the paid priority line (QA-396)", async () => {
    const repo = fakeRepo({
      loadMatchContext: async (id: string) => ({
        matchId: id,
        rfqId: "r1",
        state: "pending",
        rfqStatus: "new",
        operatorEmail: "ops@alpinejet.example",
        operatorName: "Alpine Jet",
        rfqFields: { departure: "ZRH", arrival: "NCE" },
        buyerEmail: "buyer@x.com",
        rfqConcierge: true,
        listingTitle: "Phenom 300 charter",
      }),
    });
    sent.length = 0;
    await handleJob(deps(repo), "email.quote_notification", {
      matchId: "m9",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("New RFQ");
    expect(sent[0]!.text).toContain(
      "Priority request — the buyer paid for immediate delivery.",
    );
    expect(sent[0]!.html ?? "").toContain("Priority request");
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
        rfqConcierge: false,
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
        rfqConcierge: false,
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

describe("notifyExpiredListings", () => {
  const jetsExpiry = { type: "empty_leg", attributeKey: "date" };

  it("no-ops entirely on a vertical without dated inventory (machinery)", async () => {
    const repo = fakeRepo({
      sweepExpiredListings: async () => {
        throw new Error("must not be called");
      },
    });
    sent.length = 0;
    const d = deps(repo); // deps.expiry unset
    expect(await notifyExpiredListings(d)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("mails each claimed operator and reports the count (QA-418)", async () => {
    let call: {
      vertical: string;
      type: string;
      attr: string;
      now: Date;
    } | null = null;
    const repo = fakeRepo({
      sweepExpiredListings: async (input) => {
        call = input;
        return [
          {
            listingId: "l1",
            title: "ZRH–NCE Phenom leg",
            operatorName: "Alpine Jet",
            operatorEmail: "ops@alpinejet.example",
            legDate: "2026-09-14",
          },
          {
            listingId: "l2",
            title: "GVA–LTN G650 leg",
            operatorName: "Lac Air",
            operatorEmail: "desk@lacair.example",
            legDate: "2026-09-13",
          },
        ];
      },
    });
    sent.length = 0;
    const d = deps(repo);
    d.expiry = jetsExpiry;
    expect(await notifyExpiredListings(d)).toBe(2);
    // The sweep ran scoped to this deploy's vertical + expiry shape.
    expect(call!.vertical).toBe("jets");
    expect(call!.type).toBe("empty_leg");
    expect(call!.attr).toBe("date");
    expect(sent.map((m) => m.to)).toEqual([
      "ops@alpinejet.example",
      "desk@lacair.example",
    ]);
    expect(sent[0]!.subject).toContain("expired");
    expect(sent[0]!.text).toContain("ZRH–NCE Phenom leg");
  });

  it("a failed send doesn't stop the batch; zero claims sends nothing", async () => {
    const repo = fakeRepo({
      sweepExpiredListings: async () => [
        {
          listingId: "l1",
          title: "Leg A",
          operatorName: "A",
          operatorEmail: "bad@x.example",
          legDate: "2026-09-14",
        },
        {
          listingId: "l2",
          title: "Leg B",
          operatorName: "B",
          operatorEmail: "ok@x.example",
          legDate: "2026-09-14",
        },
      ],
    });
    sent.length = 0;
    const d = deps(repo);
    d.expiry = jetsExpiry;
    d.email = {
      send: async (m) => {
        if (m.to.startsWith("bad")) throw new Error("bounce");
        sent.push(m);
        return { id: "e1", to: m.to, subject: m.subject, at: "t" };
      },
    };
    expect(await notifyExpiredListings(d)).toBe(2);
    expect(sent.map((m) => m.to)).toEqual(["ok@x.example"]);

    const empty = fakeRepo();
    sent.length = 0;
    const d2 = deps(empty);
    d2.expiry = jetsExpiry;
    expect(await notifyExpiredListings(d2)).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe("nudgeStaleQuotes (QA-422)", () => {
  it("disabled when quoteNudgeHours <= 0 — repo never called", async () => {
    const repo = fakeRepo({
      sweepStaleQuotes: async () => {
        throw new Error("must not be called");
      },
    });
    sent.length = 0;
    const d = deps(repo);
    d.quoteNudgeHours = 0;
    expect(await nudgeStaleQuotes(d)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("mails each claimed buyer with their tokened /quotes link", async () => {
    let call: { vertical: string; olderThan: Date } | null = null;
    const repo = fakeRepo({
      sweepStaleQuotes: async (input) => {
        call = input;
        return [
          {
            rfqId: "r1",
            buyerEmail: "buyer@x.com",
            accessToken: "tok-one",
            listingTitle: "ZRH–NCE Phenom leg",
            quoteCount: 2,
          },
          {
            rfqId: "r2",
            buyerEmail: "buyer2@x.com",
            accessToken: "tok two",
            listingTitle: null,
            quoteCount: 1,
          },
        ];
      },
    });
    sent.length = 0;
    const d = deps(repo);
    d.quoteNudgeHours = 48;
    expect(await nudgeStaleQuotes(d)).toBe(2);
    expect(call!.vertical).toBe("jets");
    // olderThan = deps.now - 48h — deps.now is fixed 2026-09-15T12:00Z.
    expect(call!.olderThan.toISOString()).toBe("2026-09-13T12:00:00.000Z");
    expect(sent.map((m) => m.to)).toEqual(["buyer@x.com", "buyer2@x.com"]);
    expect(sent[0]!.subject).toBe("2 quotes are waiting on your request");
    expect(sent[1]!.subject).toBe("1 quote is waiting on your request");
    // The fragment bearer token deep-links the buyer's inbox (AGENTS: #t=).
    expect(sent[0]!.text).toContain("/quotes?email=buyer%40x.com#t=tok-one");
    expect(sent[0]!.text).toContain("ZRH–NCE Phenom leg");
    expect(sent[1]!.text).toContain("#t=tok%20two");
  });

  it("defaults to 48h, a failed send doesn't stall, zero claims sends nothing", async () => {
    const repo = fakeRepo({
      sweepStaleQuotes: async () => [
        {
          rfqId: "r1",
          buyerEmail: "bad@x.example",
          accessToken: "t1",
          listingTitle: "A",
          quoteCount: 1,
        },
        {
          rfqId: "r2",
          buyerEmail: "ok@x.example",
          accessToken: "t2",
          listingTitle: "B",
          quoteCount: 3,
        },
      ],
    });
    sent.length = 0;
    const d = deps(repo); // quoteNudgeHours unset → 48h default
    d.email = {
      send: async (m) => {
        if (m.to.startsWith("bad")) throw new Error("bounce");
        sent.push(m);
        return { id: "e1", to: m.to, subject: m.subject, at: "t" };
      },
    };
    expect(await nudgeStaleQuotes(d)).toBe(2);
    expect(sent.map((m) => m.to)).toEqual(["ok@x.example"]);

    const empty = fakeRepo();
    sent.length = 0;
    expect(await nudgeStaleQuotes(deps(empty))).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe("nudgeUnquotedRfqs (QA-423)", () => {
  it("disabled when unquotedNudgeHours <= 0 — repo never called", async () => {
    const repo = fakeRepo({
      sweepUnquotedRfqs: async () => {
        throw new Error("must not be called");
      },
    });
    sent.length = 0;
    const d = deps(repo);
    d.unquotedNudgeHours = 0;
    expect(await nudgeUnquotedRfqs(d)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("mails each claimed buyer — copy names the operator reach", async () => {
    let call: { vertical: string; olderThan: Date } | null = null;
    const repo = fakeRepo({
      sweepUnquotedRfqs: async (input) => {
        call = input;
        return [
          {
            rfqId: "r1",
            buyerEmail: "buyer@x.com",
            accessToken: "tok-one",
            listingTitle: "ZRH–NCE Phenom leg",
            matchCount: 3,
          },
          {
            rfqId: "r2",
            buyerEmail: "buyer2@x.com",
            accessToken: "tok two",
            listingTitle: null,
            matchCount: 0,
          },
        ];
      },
    });
    sent.length = 0;
    const d = deps(repo);
    d.unquotedNudgeHours = 24;
    expect(await nudgeUnquotedRfqs(d)).toBe(2);
    expect(call!.vertical).toBe("jets");
    // olderThan = deps.now - 24h — deps.now is fixed 2026-09-15T12:00Z.
    expect(call!.olderThan.toISOString()).toBe("2026-09-14T12:00:00.000Z");
    expect(sent.map((m) => m.to)).toEqual(["buyer@x.com", "buyer2@x.com"]);
    expect(sent[0]!.subject).toBe(
      "We're still gathering quotes for your request",
    );
    // Matched request says how many operators were notified; an unmatched
    // (direct-listing) request credits the owner instead.
    expect(sent[0]!.text).toContain("went out to 3 operators");
    expect(sent[0]!.text).toContain("ZRH–NCE Phenom leg");
    expect(sent[1]!.text).toContain("went straight to the listing owner");
    // Fragment-token deep link (AGENTS: bearer tokens travel in #t=).
    expect(sent[0]!.text).toContain("/quotes?email=buyer%40x.com#t=tok-one");
  });

  it("defaults to 24h, a failed send doesn't stall, zero claims silent", async () => {
    const repo = fakeRepo({
      sweepUnquotedRfqs: async () => [
        {
          rfqId: "r1",
          buyerEmail: "bad@x.example",
          accessToken: "t1",
          listingTitle: "A",
          matchCount: 1,
        },
        {
          rfqId: "r2",
          buyerEmail: "ok@x.example",
          accessToken: "t2",
          listingTitle: "B",
          matchCount: 5,
        },
      ],
    });
    sent.length = 0;
    const d = deps(repo); // unquotedNudgeHours unset → 24h default
    d.email = {
      send: async (m) => {
        if (m.to.startsWith("bad")) throw new Error("bounce");
        sent.push(m);
        return { id: "e1", to: m.to, subject: m.subject, at: "t" };
      },
    };
    expect(await nudgeUnquotedRfqs(d)).toBe(2);
    expect(sent.map((m) => m.to)).toEqual(["ok@x.example"]);
    expect(sent[0]!.text).toContain("went out to 5 operators");

    const empty = fakeRepo();
    sent.length = 0;
    expect(await nudgeUnquotedRfqs(deps(empty))).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe("nudgeUnansweredOperators (QA-425)", () => {
  it("disabled when unansweredNudgeHours <= 0 — repo never called", async () => {
    const repo = fakeRepo({
      sweepUnansweredOperators: async () => {
        throw new Error("must not be called");
      },
    });
    sent.length = 0;
    const d = deps(repo);
    d.unansweredNudgeHours = 0;
    expect(await nudgeUnansweredOperators(d)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("mails each claimed operator the Needs-quote inbox link", async () => {
    let call: {
      vertical: string;
      olderThan: Date;
      cooldown: Date;
    } | null = null;
    const repo = fakeRepo({
      sweepUnansweredOperators: async (input) => {
        call = input;
        return [
          { operatorId: "o1", email: "ops@alpine.example", unansweredCount: 3 },
          { operatorId: "o2", email: "solo@x.example", unansweredCount: 1 },
        ];
      },
    });
    sent.length = 0;
    const d = deps(repo);
    d.unansweredNudgeHours = 72;
    expect(await nudgeUnansweredOperators(d)).toBe(2);
    expect(call!.vertical).toBe("jets");
    // olderThan = now-72h; cooldown = now-7d — deps.now fixed 2026-09-15T12:00Z.
    expect(call!.olderThan.toISOString()).toBe("2026-09-12T12:00:00.000Z");
    expect(call!.cooldown.toISOString()).toBe("2026-09-08T12:00:00.000Z");
    expect(sent.map((m) => m.to)).toEqual([
      "ops@alpine.example",
      "solo@x.example",
    ]);
    expect(sent[0]!.subject).toBe("3 requests are waiting for your quote");
    expect(sent[1]!.subject).toBe("1 request is waiting for your quote");
    // The CTA lands on the Needs-quote inbox view — the fix for the state.
    expect(sent[0]!.text).toContain("/app/rfqs?f=needs");
    expect(sent[0]!.text).toContain("dismiss");
  });

  it("defaults to 72h, a failed send doesn't stall, zero claims silent", async () => {
    const repo = fakeRepo({
      sweepUnansweredOperators: async () => [
        { operatorId: "o1", email: "bad@x.example", unansweredCount: 2 },
        { operatorId: "o2", email: "ok@x.example", unansweredCount: 4 },
      ],
    });
    sent.length = 0;
    const d = deps(repo); // unansweredNudgeHours unset → 72h default
    d.email = {
      send: async (m) => {
        if (m.to.startsWith("bad")) throw new Error("bounce");
        sent.push(m);
        return { id: "e1", to: m.to, subject: m.subject, at: "t" };
      },
    };
    expect(await nudgeUnansweredOperators(d)).toBe(2);
    expect(sent.map((m) => m.to)).toEqual(["ok@x.example"]);
    expect(sent[0]!.subject).toBe("4 requests are waiting for your quote");

    const empty = fakeRepo();
    sent.length = 0;
    expect(await nudgeUnansweredOperators(deps(empty))).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe("remindOverdueInvoices (QA-429)", () => {
  it("disabled when invoiceReminderHours <= 0 — repo never called", async () => {
    const repo = fakeRepo({
      sweepOverdueInvoices: async () => {
        throw new Error("must not be called");
      },
    });
    sent.length = 0;
    const d = deps(repo);
    d.invoiceReminderHours = 0;
    expect(await remindOverdueInvoices(d)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("mails each claimed operator the invoice ref + fee amount", async () => {
    let call: {
      vertical: string;
      olderThan: Date;
      cooldown: Date;
    } | null = null;
    const repo = fakeRepo({
      sweepOverdueInvoices: async (input) => {
        call = input;
        return [
          {
            dealId: "d1aaaaaa-0000-4000-8000-000000000001",
            operatorId: "o1",
            email: "ops@alpine.example",
            invoiceRef: "inv_42",
            feeAmountMinor: 30000,
            currency: "USD",
          },
          {
            dealId: "d2bbbbbb-0000-4000-8000-000000000002",
            operatorId: "o2",
            email: "solo@x.example",
            invoiceRef: null,
            feeAmountMinor: 15050,
            currency: "USD",
          },
        ];
      },
    });
    sent.length = 0;
    const d = deps(repo);
    d.invoiceReminderHours = 72;
    expect(await remindOverdueInvoices(d)).toBe(2);
    expect(call!.vertical).toBe("jets");
    // deps.now fixed 2026-09-15T12:00Z → olderThan -72h, cooldown -7d.
    expect(call!.olderThan.toISOString()).toBe("2026-09-12T12:00:00.000Z");
    expect(call!.cooldown.toISOString()).toBe("2026-09-08T12:00:00.000Z");
    expect(sent.map((m) => m.to)).toEqual([
      "ops@alpine.example",
      "solo@x.example",
    ]);
    expect(sent[0]!.subject).toContain("inv_42");
    expect(sent[0]!.subject).toContain("300");
    // No invoiceRef → falls back to the deal-id prefix, never "null".
    expect(sent[1]!.subject).toContain("d2bbbbbb");
    expect(sent[1]!.subject).not.toContain("null");
    expect(sent[0]!.text).toContain("/app");
  });

  it("defaults to 72h and a failed send doesn't stall the rest", async () => {
    const repo = fakeRepo({
      sweepOverdueInvoices: async () => [
        {
          dealId: "d3",
          operatorId: "o1",
          email: "bad@x.example",
          invoiceRef: "inv_1",
          feeAmountMinor: 100,
          currency: "USD",
        },
        {
          dealId: "d4",
          operatorId: "o2",
          email: "ok@x.example",
          invoiceRef: "inv_2",
          feeAmountMinor: 200,
          currency: "USD",
        },
      ],
    });
    sent.length = 0;
    const d = deps(repo); // invoiceReminderHours unset → 72h default
    d.email = {
      send: async (m) => {
        if (m.to.startsWith("bad")) throw new Error("bounce");
        sent.push(m);
        return { id: "e1", to: m.to, subject: m.subject, at: "t" };
      },
    };
    expect(await remindOverdueInvoices(d)).toBe(2);
    expect(sent.map((m) => m.to)).toEqual(["ok@x.example"]);
    expect(sent[0]!.subject).toContain("inv_2");

    const empty = fakeRepo();
    sent.length = 0;
    expect(await remindOverdueInvoices(deps(empty))).toBe(0);
    expect(sent).toEqual([]);
  });
});
