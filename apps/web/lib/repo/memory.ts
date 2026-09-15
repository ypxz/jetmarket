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

  async createUser(email: string, role: UserRole = "buyer"): Promise<User> {
    const existing = await this.findUserByEmail(email);
    if (existing) return existing;
    const u: User = { id: uid("usr"), email, role, createdAt: now() };
    this.users.set(u.id, u);
    return u;
  }
  async findUserByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email);
  }
  async getUser(id: string) {
    return this.users.get(id);
  }

  async upsertOperator(
    o: Omit<Operator, "id" | "createdAt"> & { id?: string },
  ): Promise<Operator> {
    const id = o.id ?? uid("op");
    const prev = this.operators.get(id);
    const op: Operator = { ...o, id, createdAt: prev?.createdAt ?? now() };
    this.operators.set(id, op);
    return op;
  }
  async getOperator(id: string) {
    return this.operators.get(id);
  }
  async getOperatorByUserId(userId: string) {
    return [...this.operators.values()].find((o) => o.userId === userId);
  }
  async listOperators() {
    return [...this.operators.values()];
  }
  async setOperatorVerified(id: string, verified: boolean) {
    const op = this.operators.get(id);
    if (op) this.operators.set(id, { ...op, verified });
  }
  async setOperatorPlan(id: string, plan: Plan) {
    const op = this.operators.get(id);
    if (op) this.operators.set(id, { ...op, plan });
  }

  async createListing(
    l: Omit<Listing, "id" | "createdAt" | "status"> & {
      status?: Listing["status"];
    },
  ): Promise<Listing> {
    const listing: Listing = {
      ...l,
      id: uid("lst"),
      status: l.status ?? "active",
      createdAt: now(),
    };
    this.listings.set(listing.id, listing);
    return listing;
  }
  async getListing(id: string) {
    return this.listings.get(id);
  }
  async listListings(filter?: {
    operatorId?: string;
    status?: Listing["status"];
    type?: Listing["type"];
    vertical?: string;
    query?: string;
    facets?: Record<string, string>;
  }): Promise<Listing[]> {
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
  async updateListingStatus(id: string, status: Listing["status"]) {
    const l = this.listings.get(id);
    if (l) this.listings.set(id, { ...l, status });
  }
  async countOperatorListings(operatorId: string) {
    return [...this.listings.values()].filter(
      (l) => l.operatorId === operatorId && l.status !== "archived",
    ).length;
  }

  async createRfq(r: Omit<Rfq, "id" | "createdAt" | "status">): Promise<Rfq> {
    const rfq: Rfq = { ...r, id: uid("rfq"), status: "open", createdAt: now() };
    this.rfqs.set(rfq.id, rfq);
    return rfq;
  }
  async getRfq(id: string) {
    return this.rfqs.get(id);
  }
  async listRfqs(filter?: { buyerEmail?: string; operatorId?: string }): Promise<Rfq[]> {
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

  async createQuote(q: Omit<Quote, "id" | "createdAt" | "status">): Promise<Quote> {
    const quote: Quote = { ...q, id: uid("quo"), status: "sent", createdAt: now() };
    this.quotes.set(quote.id, quote);
    const rfq = this.rfqs.get(quote.rfqId);
    if (rfq) this.rfqs.set(rfq.id, { ...rfq, status: "quoted" });
    return quote;
  }
  async getQuote(id: string) {
    return this.quotes.get(id);
  }
  async listQuotes(filter?: { rfqId?: string; operatorId?: string }): Promise<Quote[]> {
    let out = [...this.quotes.values()];
    if (filter?.rfqId) out = out.filter((q) => q.rfqId === filter.rfqId);
    if (filter?.operatorId) out = out.filter((q) => q.operatorId === filter.operatorId);
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async setQuoteStatus(id: string, status: Quote["status"]) {
    const q = this.quotes.get(id);
    if (q) this.quotes.set(id, { ...q, status });
  }

  async createDeal(d: Omit<Deal, "id" | "closedAt">): Promise<Deal> {
    const deal: Deal = { ...d, id: uid("deal"), closedAt: now() };
    this.deals.set(deal.id, deal);
    return deal;
  }
  async setDealInvoice(
    id: string,
    status: Deal["invoiceStatus"],
    ref?: string,
  ) {
    const deal = this.deals.get(id);
    if (deal)
      this.deals.set(id, { ...deal, invoiceStatus: status, invoiceRef: ref });
  }
  async listDeals(filter?: { operatorId?: string }): Promise<Deal[]> {
    let out = [...this.deals.values()];
    if (filter?.operatorId) out = out.filter((d) => d.operatorId === filter.operatorId);
    return out.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
  }

  async upsertSubscription(s: Omit<Subscription, "id">): Promise<Subscription> {
    const prev = await this.getSubscription(s.operatorId);
    const sub: Subscription = { ...s, id: prev?.id ?? uid("sub") };
    this.subscriptions.set(s.operatorId, sub);
    return sub;
  }
  async getSubscription(operatorId: string) {
    return this.subscriptions.get(operatorId);
  }
}

export async function seedMemoryRepo(repo: MemoryRepo) {
  const vertical = process.env.VERTICAL ?? "jets";
  await seedJets(repo);
  if (vertical === "machinery") await seedMachinery(repo);
}

async function seedJets(repo: MemoryRepo) {
  const ops = [
    { email: "ops@alpine-air.example", name: "Alpine Air Charter", base: "ZRH", fleet: "Phenom 300, CJ4", verified: true, plan: "pro" as Plan },
    { email: "ops@lake-jet.example", name: "Lake Jet Geneva", base: "GVA", fleet: "Challenger 350", verified: true, plan: "free" as Plan },
    { email: "ops@riviera-wings.example", name: "Riviera Wings", base: "NCE", fleet: "G650, Falcon 2000", verified: false, plan: "free" as Plan },
    { email: "ops@thames-exec.example", name: "Thames Executive", base: "LTN", fleet: "Praetor 600", verified: true, plan: "pro" as Plan },
  ];
  const opIds: string[] = [];
  for (const o of ops) {
    const u = await repo.createUser(o.email, "operator");
    const op = await repo.upsertOperator({
      userId: u.id,
      name: o.name,
      baseAirport: o.base,
      fleetSummary: o.fleet,
      verified: o.verified,
      plan: o.plan,
    });
    opIds.push(op.id);
  }
  const mk = async (
    operatorId: string,
    type: Listing["type"],
    title: string,
    price: number,
    attributes: Record<string, unknown>,
  ) =>
    await repo.createListing({
      operatorId,
      vertical: "jets",
      type,
      title,
      attributes,
      price,
      currency: "USD",
      photos: [],
    });

  await mk(opIds[0]!, "empty_leg", "Empty leg Zurich → Nice · Phenom 300", 4200, {
    aircraftCategory: "light", model: "Phenom 300", year: 2021, seats: 7,
    rangeNm: 2000, from: "ZRH", to: "NCE", date: "2026-09-22",
  });
  await mk(opIds[0]!, "empty_leg", "Empty leg Geneva → London · CJ4", 6800, {
    aircraftCategory: "light", model: "Citation CJ4", year: 2019, seats: 8,
    rangeNm: 2165, from: "GVA", to: "LTN", date: "2026-09-24",
  });
  await mk(opIds[1]!, "charter", "Challenger 350 on-demand charter · Geneva", 8500, {
    aircraftCategory: "super_mid", model: "Challenger 350", year: 2020,
    seats: 9, rangeNm: 3200, baseAirport: "GVA",
  });
  await mk(opIds[1]!, "empty_leg", "Empty leg Nice → Zurich · Challenger 350", 7400, {
    aircraftCategory: "super_mid", model: "Challenger 350", year: 2020,
    seats: 9, rangeNm: 3200, from: "NCE", to: "ZRH", date: "2026-09-25",
  });
  await mk(opIds[2]!, "aircraft_sale", "Gulfstream G650 (2018) for sale", 38500000, {
    aircraftCategory: "ultra_long", model: "G650", year: 2018, seats: 14,
    rangeNm: 7000, hoursTotal: 1450,
  });
  await mk(opIds[2]!, "charter", "Falcon 2000LXS charter · Nice base", 7200, {
    aircraftCategory: "heavy", model: "Falcon 2000LXS", year: 2017, seats: 10,
    rangeNm: 4000, baseAirport: "NCE",
  });
  await mk(opIds[3]!, "empty_leg", "Empty leg London → Geneva · Praetor 600", 5900, {
    aircraftCategory: "mid", model: "Praetor 600", year: 2022, seats: 8,
    rangeNm: 4018, from: "LTN", to: "GVA", date: "2026-09-23",
  });
  await mk(opIds[3]!, "charter", "Praetor 600 charter · London Luton", 6300, {
    aircraftCategory: "mid", model: "Praetor 600", year: 2022, seats: 8,
    rangeNm: 4018, baseAirport: "LTN",
  });
}

// Placeholder machinery inventory — proves the same repo/flow works for the
// second vertical (spec: machinery content is scaffold-only tonight).
async function seedMachinery(repo: MemoryRepo) {
  const u = await repo.createUser("ops@alpine-machinery.example", "operator");
  const op = await repo.upsertOperator({
    userId: u.id,
    name: "Alpine Industrial Machines",
    baseAirport: "ZRH",
    fleetSummary: "Decommissioned CNC + presses",
    verified: true,
    plan: "free",
  });
  const mk = async (type: string, title: string, price: number, attributes: Record<string, unknown>) =>
    await repo.createListing({
      operatorId: op.id,
      vertical: "machinery",
      type,
      title,
      attributes,
      price,
      currency: "EUR",
      photos: [],
    });
  await mk("for_sale", "DMG Mori CNC milling centre (2016)", 145000, {
    machineryCategory: "cnc_milling", make: "DMG Mori", yearOfManufacture: 2016,
    hoursUsed: 8200, condition: "used",
  });
  await mk("for_rent", "Kaeser industrial compressor · monthly", 1200, {
    machineryCategory: "generator", make: "Kaeser", yearOfManufacture: 2020,
    hoursUsed: 3100, condition: "used",
  });
  await mk("auction", "Hydraulic press 400t — liquidation lot", 28000, {
    machineryCategory: "press", make: "Schuler", yearOfManufacture: 2008,
    hoursUsed: 31000, condition: "decommissioned",
  });
}

export async function createMemoryRepo(): Promise<MemoryRepo> {
  const repo = new MemoryRepo();
  await seedMemoryRepo(repo);
  return repo;
}

// module singleton survives Next dev HMR via globalThis
const g = globalThis as unknown as { __jmRepo?: MemoryRepo };
export async function getMemoryRepo(): Promise<MemoryRepo> {
  if (!g.__jmRepo) g.__jmRepo = await createMemoryRepo();
  return g.__jmRepo;
}
