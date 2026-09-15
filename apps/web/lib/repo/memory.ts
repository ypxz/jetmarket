import type {
  Deal,
  Listing,
  Operator,
  Plan,
  Quote,
  Repo,
  Rfq,
  Subscription,
  User,
  UserRole,
} from "./types";

const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const now = () => new Date().toISOString();

class MemoryRepo implements Repo {
  users = new Map<string, User>();
  operators = new Map<string, Operator>();
  listings = new Map<string, Listing>();
  rfqs = new Map<string, Rfq>();
  quotes = new Map<string, Quote>();
  deals = new Map<string, Deal>();
  subscriptions = new Map<string, Subscription>();

  createUser(email: string, role: UserRole = "buyer"): User {
    const existing = this.findUserByEmail(email);
    if (existing) return existing;
    const u: User = { id: uid("usr"), email, role, createdAt: now() };
    this.users.set(u.id, u);
    return u;
  }
  findUserByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email);
  }
  getUser(id: string) {
    return this.users.get(id);
  }

  upsertOperator(
    o: Omit<Operator, "id" | "createdAt"> & { id?: string },
  ): Operator {
    const id = o.id ?? uid("op");
    const prev = this.operators.get(id);
    const op: Operator = { ...o, id, createdAt: prev?.createdAt ?? now() };
    this.operators.set(id, op);
    return op;
  }
  getOperator(id: string) {
    return this.operators.get(id);
  }
  getOperatorByUserId(userId: string) {
    return [...this.operators.values()].find((o) => o.userId === userId);
  }
  listOperators() {
    return [...this.operators.values()];
  }
  setOperatorVerified(id: string, verified: boolean) {
    const op = this.operators.get(id);
    if (op) this.operators.set(id, { ...op, verified });
  }
  setOperatorPlan(id: string, plan: Plan) {
    const op = this.operators.get(id);
    if (op) this.operators.set(id, { ...op, plan });
  }

  createListing(
    l: Omit<Listing, "id" | "createdAt" | "status"> & {
      status?: Listing["status"];
    },
  ): Listing {
    const listing: Listing = {
      ...l,
      id: uid("lst"),
      status: l.status ?? "active",
      createdAt: now(),
    };
    this.listings.set(listing.id, listing);
    return listing;
  }
  getListing(id: string) {
    return this.listings.get(id);
  }
  listListings(filter?: {
    operatorId?: string;
    status?: Listing["status"];
    type?: Listing["type"];
    vertical?: string;
    query?: string;
    facets?: Record<string, string>;
  }): Listing[] {
    let out = [...this.listings.values()];
    if (filter?.operatorId) out = out.filter((l) => l.operatorId === filter.operatorId);
    if (filter?.status) out = out.filter((l) => l.status === filter.status);
    if (filter?.type) out = out.filter((l) => l.type === filter.type);
    if (filter?.vertical) out = out.filter((l) => l.vertical === filter.vertical);
    if (filter?.query) {
      const q = filter.query.toLowerCase();
      out = out.filter((l) =>
        [l.title, JSON.stringify(l.attributes)]
          .join(" ")
          .toLowerCase()
          .includes(q),
      );
    }
    if (filter?.facets) {
      for (const [k, v] of Object.entries(filter.facets)) {
        if (!v) continue;
        out = out.filter((l) => String(l.attributes[k] ?? "") === v);
      }
    }
    return out;
  }
  updateListingStatus(id: string, status: Listing["status"]) {
    const l = this.listings.get(id);
    if (l) this.listings.set(id, { ...l, status });
  }
  countOperatorListings(operatorId: string) {
    return [...this.listings.values()].filter(
      (l) => l.operatorId === operatorId && l.status !== "archived",
    ).length;
  }

  createRfq(r: Omit<Rfq, "id" | "createdAt" | "status">): Rfq {
    const rfq: Rfq = { ...r, id: uid("rfq"), status: "open", createdAt: now() };
    this.rfqs.set(rfq.id, rfq);
    return rfq;
  }
  getRfq(id: string) {
    return this.rfqs.get(id);
  }
  listRfqs(filter?: { buyerEmail?: string; operatorId?: string }): Rfq[] {
    let out = [...this.rfqs.values()];
    if (filter?.buyerEmail) out = out.filter((r) => r.buyerEmail === filter.buyerEmail);
    if (filter?.operatorId) {
      const opListingIds = new Set(
        [...this.listings.values()]
          .filter((l) => l.operatorId === filter.operatorId)
          .map((l) => l.id),
      );
      out = out.filter((r) => opListingIds.has(r.listingId));
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  createQuote(q: Omit<Quote, "id" | "createdAt" | "status">): Quote {
    const quote: Quote = { ...q, id: uid("quo"), status: "sent", createdAt: now() };
    this.quotes.set(quote.id, quote);
    const rfq = this.rfqs.get(quote.rfqId);
    if (rfq) this.rfqs.set(rfq.id, { ...rfq, status: "quoted" });
    return quote;
  }
  getQuote(id: string) {
    return this.quotes.get(id);
  }
  listQuotes(filter?: { rfqId?: string; operatorId?: string }): Quote[] {
    let out = [...this.quotes.values()];
    if (filter?.rfqId) out = out.filter((q) => q.rfqId === filter.rfqId);
    if (filter?.operatorId) out = out.filter((q) => q.operatorId === filter.operatorId);
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  setQuoteStatus(id: string, status: Quote["status"]) {
    const q = this.quotes.get(id);
    if (q) this.quotes.set(id, { ...q, status });
  }

  createDeal(d: Omit<Deal, "id" | "closedAt">): Deal {
    const deal: Deal = { ...d, id: uid("deal"), closedAt: now() };
    this.deals.set(deal.id, deal);
    return deal;
  }
  listDeals(filter?: { operatorId?: string }): Deal[] {
    let out = [...this.deals.values()];
    if (filter?.operatorId) out = out.filter((d) => d.operatorId === filter.operatorId);
    return out.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
  }

  upsertSubscription(s: Omit<Subscription, "id">): Subscription {
    const prev = this.getSubscription(s.operatorId);
    const sub: Subscription = { ...s, id: prev?.id ?? uid("sub") };
    this.subscriptions.set(s.operatorId, sub);
    return sub;
  }
  getSubscription(operatorId: string) {
    return this.subscriptions.get(operatorId);
  }
}

export function seedMemoryRepo(repo: MemoryRepo) {
  const ops = [
    { email: "ops@alpine-air.example", name: "Alpine Air Charter", base: "ZRH", fleet: "Phenom 300, CJ4", verified: true, plan: "pro" as Plan },
    { email: "ops@lake-jet.example", name: "Lake Jet Geneva", base: "GVA", fleet: "Challenger 350", verified: true, plan: "free" as Plan },
    { email: "ops@riviera-wings.example", name: "Riviera Wings", base: "NCE", fleet: "G650, Falcon 2000", verified: false, plan: "free" as Plan },
    { email: "ops@thames-exec.example", name: "Thames Executive", base: "LTN", fleet: "Praetor 600", verified: true, plan: "pro" as Plan },
  ];
  const opIds: string[] = [];
  for (const o of ops) {
    const u = repo.createUser(o.email, "operator");
    const op = repo.upsertOperator({
      userId: u.id,
      name: o.name,
      baseAirport: o.base,
      fleetSummary: o.fleet,
      verified: o.verified,
      plan: o.plan,
    });
    opIds.push(op.id);
  }
  const mk = (
    operatorId: string,
    type: Listing["type"],
    title: string,
    price: number,
    attributes: Record<string, unknown>,
  ) =>
    repo.createListing({
      operatorId,
      vertical: "jets",
      type,
      title,
      attributes,
      price,
      currency: "USD",
      photos: [],
    });

  mk(opIds[0]!, "empty_leg", "Empty leg Zurich → Nice · Phenom 300", 4200, {
    aircraftCategory: "light", model: "Phenom 300", year: 2021, seats: 7,
    rangeNm: 2000, from: "ZRH", to: "NCE", date: "2026-09-22",
  });
  mk(opIds[0]!, "empty_leg", "Empty leg Geneva → London · CJ4", 6800, {
    aircraftCategory: "light", model: "Citation CJ4", year: 2019, seats: 8,
    rangeNm: 2165, from: "GVA", to: "LTN", date: "2026-09-24",
  });
  mk(opIds[1]!, "charter", "Challenger 350 on-demand charter · Geneva", 8500, {
    aircraftCategory: "super_mid", model: "Challenger 350", year: 2020,
    seats: 9, rangeNm: 3200, baseAirport: "GVA",
  });
  mk(opIds[1]!, "empty_leg", "Empty leg Nice → Zurich · Challenger 350", 7400, {
    aircraftCategory: "super_mid", model: "Challenger 350", year: 2020,
    seats: 9, rangeNm: 3200, from: "NCE", to: "ZRH", date: "2026-09-25",
  });
  mk(opIds[2]!, "aircraft_sale", "Gulfstream G650 (2018) for sale", 38500000, {
    aircraftCategory: "ultra_long", model: "G650", year: 2018, seats: 14,
    rangeNm: 7000, hoursTotal: 1450,
  });
  mk(opIds[2]!, "charter", "Falcon 2000LXS charter · Nice base", 7200, {
    aircraftCategory: "heavy", model: "Falcon 2000LXS", year: 2017, seats: 10,
    rangeNm: 4000, baseAirport: "NCE",
  });
  mk(opIds[3]!, "empty_leg", "Empty leg London → Geneva · Praetor 600", 5900, {
    aircraftCategory: "mid", model: "Praetor 600", year: 2022, seats: 8,
    rangeNm: 4018, from: "LTN", to: "GVA", date: "2026-09-23",
  });
  mk(opIds[3]!, "charter", "Praetor 600 charter · London Luton", 6300, {
    aircraftCategory: "mid", model: "Praetor 600", year: 2022, seats: 8,
    rangeNm: 4018, baseAirport: "LTN",
  });
}

// module singleton survives Next dev HMR via globalThis
const g = globalThis as unknown as { __jmRepo?: MemoryRepo };
export function getMemoryRepo(): MemoryRepo {
  if (!g.__jmRepo) {
    g.__jmRepo = new MemoryRepo();
    seedMemoryRepo(g.__jmRepo);
  }
  return g.__jmRepo;
}
