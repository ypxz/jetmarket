import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { EmailMessage } from "@jetmarket/providers/email/index";
import { defaultPlans } from "@jetmarket/domain";
import { deliverDueMatches, handleJob, rfqFanout } from "./handlers";
import type { WorkerDeps } from "./handlers";
import type { WorkerRepo } from "./repo";

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
    deliverDueMatches: async (now) => {
      rec("deliverDueMatches", now);
      return ["m-due-1", "m-due-2"];
    },
    loadMatchContext: async (id) => {
      rec("loadMatchContext", id);
      return {
        matchId: id,
        rfqId: "r1",
        operatorEmail: "ops@alpinejet.example",
        operatorName: "Alpine Jet",
        rfqFields: { departure: "ZRH", arrival: "NCE", passengers: 6 },
        buyerEmail: "buyer@x.com",
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

  it("throws on unknown job kinds", async () => {
    await expect(
      handleJob(deps(fakeRepo()), "bogus", {}),
    ).rejects.toThrow(/unknown job kind/);
  });
});
