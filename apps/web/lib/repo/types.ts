// Repository contract for the marketplace core. Mirrors spec §Data model so
// implementations (in-memory, Drizzle/Postgres) stay swappable per process.
// All methods are async — sync impls resolve immediately.

// Listing type is a slug from the active VerticalConfig.listingTypes —
// jets: charter|empty_leg|aircraft_sale, machinery: for_sale|for_rent|auction.
export type ListingType = string;
export type ListingStatus = "draft" | "active" | "paused" | "archived";
export type ListingSort = "newest" | "price_asc" | "price_desc";
export type UserRole = "buyer" | "operator" | "admin";
export type Plan = "free" | "pro";

export interface User {
  id: string;
  email: string;
  role: UserRole;
  /** Session cookies embed this; bumping revokes all sessions server-side. */
  sessionVersion: number;
  createdAt: string;
}

export interface Operator {
  id: string;
  userId: string;
  name: string;
  baseAirport: string;
  fleetSummary: string;
  verified: boolean;
  plan: Plan;
  /** Last time /app/rfqs rendered for this operator — newer inbox arrivals
   *  badge "New" (QA-416). NULL = inbox never visited (everything is new). */
  inboxSeenAt?: string;
  /** Away switch (QA-427): false = excluded from new RFQ fan-outs.
   *  Already-delivered matches stay in the inbox. Default true. */
  acceptingRfqs: boolean;
  createdAt: string;
}

/** Fields safe to expose on public/buyer-facing payloads — userId and plan
 * are internal (auth linkage, billing tier) and never leave the server. */
export interface PublicOperator {
  name: string;
  baseAirport: string;
  fleetSummary: string;
  verified: boolean;
}

export function publicOperator(o: Operator): PublicOperator {
  return {
    name: o.name,
    baseAirport: o.baseAirport,
    fleetSummary: o.fleetSummary,
    verified: o.verified,
  };
}

export interface Listing {
  id: string;
  operatorId: string;
  vertical: string;
  type: ListingType;
  title: string;
  attributes: Record<string, unknown>;
  price: number;
  currency: string;
  status: ListingStatus;
  photos: string[];
  /** Public-page view counter — bump-on-read, not write-gated (QA-413). */
  views: number;
  createdAt: string;
}

// "matched"/"spam" are db-side states that surface through iface reads.
export type RfqStatus =
  | "open"
  | "matched"
  | "quoted"
  | "closed"
  | "expired"
  | "spam";

export interface Rfq {
  id: string;
  vertical: string;
  /** FK `set null` — survives a listing delete as null; renders via the
   *  listingFallback copy (QA-419). */
  listingId: string | null;
  buyerEmail: string;
  /** Bearer token in the buyer's email link — gates quote view/accept/decline. */
  accessToken: string;
  fields: Record<string, unknown>;
  /** Buyer concierge ($49/request): paid expedite — delayed fan-out matches
   *  deliver immediately instead of after the free-plan delay. */
  concierge: boolean;
  status: RfqStatus;
  createdAt: string;
}

export type QuoteStatus = "sent" | "accepted" | "declined" | "withdrawn";

/** Read projection of a background-job row (worker queue) for admin ops. */
export interface JobInfo {
  id: string;
  kind: string;
  status: "pending" | "running" | "done" | "failed";
  runAt: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  updatedAt: string;
}

export interface Quote {
  id: string;
  rfqId: string;
  operatorId: string;
  amount: number;
  currency: string;
  message: string;
  status: QuoteStatus;
  createdAt: string;
  /** Bumped on every write (status flips, revisions). A still-'sent'
   *  quote with updatedAt !== createdAt was revised — the buyer marks it
   *  "Updated" (QA-445). */
  updatedAt: string;
}

export interface Deal {
  id: string;
  quoteId: string;
  operatorId: string;
  amount: number;
  /** Quote's currency — machinery runs EUR; never hardcode a display one. */
  currency: string;
  feePct: number;
  feeAmount: number;
  invoiceStatus: "pending" | "invoiced" | "paid" | "void";
  /** Provider-side invoice id (stripe-mock `in_…` or mock `inv_…`). */
  invoiceRef?: string;
  closedAt: string;
  /** Resolved off the parent quote→rfq→listing when the read joins them
   *  (listDeals): a closed deal unlocks the buyer's contact + which listing
   *  it was — the marketplace's job is done, fulfilment is theirs. */
  rfqId?: string;
  buyerEmail?: string;
  listingTitle?: string;
}

/** Saved-search alert (QA-403): a buyer's whitelisted /search filter set +
 * confirm/unsubscribe bearer. `pendingIds` queues matched listings during
 * the per-alert mail cooldown and flushes with the next digest. */
export type SearchAlertStatus = "pending" | "active" | "off";
/** 'instant' mails at match time (cooldown batches); 'daily' never
 *  instant-mails — every match queues into the matured-backlog digest. */
export type SearchAlertFreq = "instant" | "daily";
export interface SearchAlert {
  id: string;
  vertical: string;
  email: string;
  /** Raw /search params — only ever re-applied through listingFilterFor. */
  params: Record<string, unknown>;
  token: string;
  status: SearchAlertStatus;
  pendingIds: string[];
  lastAlertedAt: string | null;
  createdAt: string;
  freq: SearchAlertFreq;
}

export interface Subscription {
  id: string;
  operatorId: string;
  plan: Plan;
  status: "active" | "canceled" | "past_due";
  currentPeriodEnd: string;
  /** Provider event stamp (unix s); unstamped writes always apply. */
  lastEventAt?: number;
}

/** Thrown when a write would exceed the caller's listing cap. */
export class PlanCapError extends Error {
  constructor() {
    super("free plan listing cap reached");
    this.name = "PlanCapError";
  }
}

export interface Repo {
  createUser(email: string, role?: UserRole): Promise<User>;
  findUserByEmail(email: string): Promise<User | undefined>;
  getUser(id: string): Promise<User | undefined>;
  /** Batch-lookup users by id — join-style admin pages. */
  listUsers(ids: string[]): Promise<User[]>;
  /** Invalidate every outstanding session for the user (logout). */
  bumpSessionVersion(userId: string): Promise<void>;
  /** ADMIN_EMAILS sync on login — promote listed users, revoke removed ones. */
  setUserRole(userId: string, role: UserRole): Promise<void>;
  /**
   * Magic-link single-use ledger (QA-250): atomically records a consumed
   * signature, returning false when it was already used. Repo-backed (not
   * process memory) so a restart can't re-arm a link and a multi-instance
   * deploy keeps one-shot semantics.
   */
  consumeMagicLinkSig(sig: string, expiresAt: string): Promise<boolean>;

  upsertOperator(
    o: Omit<Operator, "id" | "createdAt" | "acceptingRfqs"> & {
      id?: string;
      acceptingRfqs?: boolean;
    },
  ): Promise<Operator>;
  getOperator(id: string): Promise<Operator | undefined>;
  getOperatorByUserId(userId: string): Promise<Operator | undefined>;
  listOperators(filter?: {
    limit?: number;
    offset?: number;
    ids?: string[];
  }): Promise<Operator[]>;
  countOperators(): Promise<number>;
  /** Public operator directory (QA-426): operators with ≥1 ACTIVE listing
   *  in `vertical`, most-active first — one grouped read, no N+1.
   *  `notExpiredByAttr` applies the same dated-inventory exclusion browse
   *  and the /operators/[id] profile use, so the count shown equals the
   *  listings the profile actually renders. Draft/paused/archived rows
   *  don't qualify an operator and don't count. */
  listOperatorDirectory(input: {
    vertical: string;
    notExpiredByAttr?: { type: string; attr: string; asOf: string };
    limit?: number;
  }): Promise<{ operator: Operator; activeCount: number }[]>;
  setOperatorVerified(id: string, verified: boolean): Promise<void>;
  setOperatorPlan(id: string, plan: Plan): Promise<void>;
  /** Away switch (QA-427): flip whether fan-out candidates include this
   *  operator. Does not touch already-delivered matches or the inbox. */
  setOperatorAccepting(id: string, accepting: boolean): Promise<void>;

  createListing(
    l: Omit<Listing, "id" | "createdAt" | "status" | "views"> & {
      status?: ListingStatus;
    },
    /** Atomic non-archived-listing cap — throws PlanCapError instead of
     *  inserting when the operator is already at the cap. */
    opts?: { cap?: number },
  ): Promise<Listing>;
  getListing(id: string): Promise<Listing | undefined>;
  /**
   * Increment a listing's public-page view counter (QA-413). Atomic at the
   * row level (SQL `views = views + 1` / synchronous memory++) — NOT part of
   * a read, so callers fire it alongside the page fetch, non-fatally.
   */
  bumpListingViews(id: string): Promise<void>;
  listListings(filter?: {
    operatorId?: string;
    status?: ListingStatus;
    type?: ListingType;
    vertical?: string;
    query?: string;
    facets?: Record<string, string>;
    /**
     * Numeric ranges on attribute keys (or the built-in `price`): a row
     * matches when its value is numeric and inside every bound. Missing or
     * non-numeric values never match.
     */
    facetRanges?: { key: string; min?: number; max?: number }[];
    /**
     * ISO (YYYY-MM-DD) date ranges on attribute keys — string compare works
     * because ISO dates sort lexicographically. Strict: a listing without the
     * attribute never matches a set bound (QA-215).
     */
    facetDateRanges?: { key: string; from?: string; to?: string }[];
    /**
     * Dated-inventory expiry (vertical.expiry): exclude rows where
     * `type` matches AND `attributes[attr]` is a string strictly before
     * `asOf` (ISO date). Missing attr keeps the row (QA-219).
     */
    notExpiredByAttr?: { type: string; attr: string; asOf: string };
    /** Only rows whose operator is verified (QA-436 search trust filter).
     *  Listings whose operator row is missing never match — mirrors the
     *  EXISTS-subquery semantics, so unverifiable rows hide rather than leak. */
    verifiedOnly?: boolean;
    /** Fetch these listing ids directly — batch-lookup for join-style pages. */
    ids?: string[];
    /** Result order — `newest` (createdAt desc) is the default. */
    sort?: ListingSort;
    /** Page slice applied after all other filters. */
    limit?: number;
    offset?: number;
  }): Promise<Listing[]>;
  /** Rows matching the same filter shape, ignoring limit/offset. */
  countListings(filter?: {
    operatorId?: string;
    status?: ListingStatus;
    type?: ListingType;
    vertical?: string;
    query?: string;
    facets?: Record<string, string>;
    facetRanges?: { key: string; min?: number; max?: number }[];
    facetDateRanges?: { key: string; from?: string; to?: string }[];
    notExpiredByAttr?: { type: string; attr: string; asOf: string };
    /** See {@link Repo.listListings}. */
    verifiedOnly?: boolean;
  }): Promise<number>;
  updateListingStatus(
    id: string,
    status: ListingStatus,
    /** Same atomic cap for reactivation — throws PlanCapError when the
     *  transition would put the operator over the limit. */
    opts?: { cap?: number },
  ): Promise<void>;
  updateListing(
    id: string,
    patch: Partial<Pick<Listing, "title" | "price" | "attributes" | "photos">>,
  ): Promise<void>;
  /** Permanent delete for terminal-ish rows only (draft/archived) — live
   *  listings carry buyer demand and must go through archive first. Scoped
   *  by operator+vertical in the write itself (a foreign id can never be
   *  reached); returns false when nothing matched, the same atomic-CAS
   *  shape as every other state transition. FK `set null` orphans RFQs
   *  and matches to `listingId: null` — the listingFallback copy renders
   *  them (QA-419). */
  deleteListing(
    id: string,
    scope: { operatorId: string; vertical: string },
  ): Promise<boolean>;
  /** Non-archived count used for the plan cap + dashboard header. `vertical`
   *  scopes it on multi-vertical shared DBs — the per-plan cap is
   *  per-deploy, so foreign-vertical rows must not consume it (QA-302). */
  countOperatorListings(
    operatorId: string,
    vertical?: string,
  ): Promise<number>;
  /** Non-archived listing counts keyed by operator id — one grouped query for
   *  admin tables that would otherwise N+1 per row. `vertical` scopes to the
   *  deploy's rows on shared DBs (QA-302). */
  listListingCountsByOperator(
    operatorIds: string[],
    vertical?: string,
  ): Promise<Record<string, number>>;

  createRfq(
    r: Omit<
      Rfq,
      "id" | "createdAt" | "status" | "accessToken" | "concierge"
    > & {
      /** sha256 natural key — collides only with a LIVE twin (open/matched/
       * quoted); inserting over a terminal RFQ mints a fresh row (QA-228). */
      dedupeKey?: string;
      /** Override the random bearer token — seeds use a known token so the
       * demo buyer-inbox link is stable (QA-237). */
      accessToken?: string;
    },
  ): Promise<Rfq>;
  getRfq(id: string): Promise<Rfq | undefined>;
  /** Lookup by dedupe key — the idempotent path after a duplicate insert.
   * Returns only the live twin; terminal RFQs don't count (QA-228). */
  getRfqByDedupeKey(key: string): Promise<Rfq | undefined>;
  /** Atomically transition an RFQ to `status` when its current status is in
   * `expectedIn`; returns false otherwise. Lets accept() use the RFQ as the
   * single-winner arbiter against concurrent sibling accepts (QA-99). */
  setRfqStatus(
    id: string,
    status: RfqStatus,
    expectedIn: RfqStatus[],
  ): Promise<boolean>;
  /**
   * Buyer-side "more time" (QA-446): CAS-gated write of `fields.dateTo` on
   * a LIVE RFQ — extending pushes the liveness horizon (QA-442's rule)
   * without a repost, which would mint a fresh RFQ and abandon the
   * delivered-to history and live quotes. An undated request becomes
   * dated by the write — deliberate: "more time" is expressed as a
   * concrete close date. Returns false on a terminal RFQ.
   */
  extendRfqDeadline(id: string, dateTo: string): Promise<boolean>;
  /**
   * Matches of this RFQ still awaiting delivery — the thing a concierge
   * purchase actually buys. pg counts `state='delayed'` (a row whose
   * deliverAt passed but the worker hasn't flipped yet still counts — the
   * concierge flip delivers it too); memory counts `deliverAt > now`.
   */
  countRfqPendingMatches(rfqId: string): Promise<number>;
  /**
   * Delivered-match counts per RFQ (the inverse side of
   * `countRfqPendingMatches`): pg counts every state besides 'delayed' —
   * pending rows ARE delivered, the notify job only flips them to 'sent';
   * memory counts `!deliverAt || deliverAt <= now`, the same visibility
   * rule `matchVisible` uses. Batch shape: one call covers a whole buyer
   * inbox page without an N+1 (QA-401 — the inbox tells the buyer how many
   * operators actually received the request).
   */
  countDeliveredMatches(rfqIds: string[]): Promise<Record<string, number>>;
  /** Buyer concierge purchase: atomically set `concierge` on a LIVE RFQ and
   *  flip its still-delayed matches to deliverable (pg: state pending at
   *  deliver_at now; memory: deliverAt now). Returns `applied: false` when
   *  the RFQ is terminal/already concierge — the paid flag is set once and
   *  never unset, and only live RFQs can be expedited (a closed/expired one
   *  must not take money for a dead request). The flipped match rows carry
   *  operatorId so callers can notify (pg: worker jobs; memory: inline). */
  expediteRfq(
    id: string,
  ): Promise<{ applied: boolean; matches: { id: string; operatorId: string }[] }>;
  listRfqs(filter?: {
    /** Batch-lookup by id (QA-424 — join-style pages fetch their RFQ
     *  context in one call instead of N getRfq round-trips). */
    ids?: string[];
    buyerEmail?: string;
    /** Listing owner OR an operator with a delivered (pending) rfq_match. */
    operatorId?: string;
    /** Per-listing inbox triage (QA-430): only RFQs filed against this
     *  listing — open requests (listingId null) and match-only visibility
     *  don't qualify, the "requests" chip deep-links here. */
    listingId?: string;
    /** Operator inbox "needs a quote" (QA-402): only meaningful with
     * `operatorId` — excludes RFQs where that operator already has a live
     * quote (`sent`/`accepted`). Declined/withdrawn quotes don't hide the
     * RFQ: there's no live quote in play, so it still needs action. */
    needsQuote?: boolean;
    /** "Dismissed" inbox view (QA-421): only meaningful with `operatorId` —
     * flips the QA-420 exclusion into a positive match so the operator can
     * review (and restore) the rows they dismissed. Rows that also left the
     * inbox entirely (listing deleted, match gone) stay out either way. */
    dismissedOnly?: boolean;
    /** "Answered" inbox view (QA-433): only meaningful with `operatorId` —
     * the exact inverse of `needsQuote` (live quote `sent`/`accepted`), so
     * the operator can review the outstanding queue they already created.
     * Declined/withdrawn quotes don't count: no live quote is in play. */
    answeredOnly?: boolean;
    /** Scope to one vertical — required on multi-vertical shared DBs (QA-293). */
    vertical?: string;
    /** Inbox ordering (QA-443): default newest-first; "deadline" orders
     *  live rows by the QA-442 liveness horizon ascending — requests that
     *  stop collecting quotes soonest surface first; terminal rows always
     *  sort after live ones by createdAt-desc (QA-448). Applied on
     *  user-scoped lists (operator or buyer inbox); concierge expedites
     *  still outrank on the operator inbox, and ONLY there — admin lists
     *  are plain newest-first. */
    sort?: "deadline";
    /** Page slice applied after other filters, newest-first. */
    limit?: number;
    offset?: number;
  }): Promise<Rfq[]>;
  /**
   * True when a delivered rfq_match links this operator to the RFQ — the
   * bearer alternative to owning the RFQ's listing (QA-65: fan-out matches
   * are only usable if the matched operator can see and quote the RFQ).
   */
  hasRfqMatch(rfqId: string, operatorId: string): Promise<boolean>;
  /**
   * Inbox triage (QA-420): hide this RFQ from the operator's listRfqs /
   * countPendingRfqs views. Per-operator state — the RFQ stays visible to
   * other operators, the buyer, and admin. Only RFQs already in their inbox
   * may be dismissed (owns the listing or holds a delivered match): returns
   * false otherwise so routes 404 instead of letting an operator dismiss —
   * and thereby probe — arbitrary ids. Idempotent: re-dismissing returns
   * true.
   */
  dismissRfq(rfqId: string, operatorId: string): Promise<boolean>;
  /**
   * QA-421: undo a dismiss — the RFQ re-enters the operator's inbox views.
   * False when the pair doesn't exist, which also covers RFQs the operator
   * could never have seen (no pair can exist without a prior dismissRfq,
   * so there's nothing to probe). Visibility itself is recomputed at read
   * time — undismissing an RFQ that has since left the inbox is a no-op.
   */
  undismissRfq(rfqId: string, operatorId: string): Promise<boolean>;
  /**
   * Stamp `inbox_seen_at = now` on the operator (QA-416) — the inbox badges
   * RFQs created after this stamp. Idempotent by nature (a timestamp write).
   */
  markInboxSeen(operatorId: string): Promise<void>;
  /**
   * Record operator matches for an RFQ. Postgres mode writes rfq_matches via
   * the worker; memory mode calls this inline so mock demos exercise the
   * multi-operator loop. A row with a future `deliverAt` is invisible until
   * due (mirrors state 'delayed'); absent `deliverAt` means delivered now.
   */
  createRfqMatches(
    rows: {
      rfqId: string;
      operatorId: string;
      listingId?: string | null;
      deliverAt?: Date;
    }[],
  ): Promise<void>;
  /**
   * Saved-search subscribe (QA-403). dedupeKey (hash of vertical+email+
   * canonical params) makes re-subscribing idempotent: an existing row gets
   * a ROTATED token (older emailed links die), 'off' rows go back to
   * 'pending' (re-opt-in must re-confirm), 'active'/'pending' keep status.
   * `created` is false on the dedupe path.
   */
  createSearchAlert(input: {
    vertical: string;
    email: string;
    params: Record<string, unknown>;
    token: string;
    dedupeKey: string;
    /** Omitted = 'instant'. A dedupe re-subscribe adopts the new freq. */
    freq?: SearchAlertFreq;
  }): Promise<{ alert: SearchAlert; created: boolean }>;
  /** Confirm-link CAS: pending→active. Returns the flipped row (the route
   *  needs `params` to redirect onto the saved search) or null when the
   *  token is unknown / already active / unsubscribed. */
  confirmSearchAlert(token: string): Promise<SearchAlert | null>;
  /** Unsubscribe-link CAS: any non-'off' status → 'off'. */
  unsubscribeSearchAlert(token: string): Promise<boolean>;
  listSearchAlerts(filter: {
    vertical: string;
    status?: SearchAlertStatus;
    /** Buyer self-service inbox: one mailbox's alerts only. */
    email?: string;
    /** Watchlist demand: only rows watching this listing id (params.watch). */
    watchListingId?: string;
  }): Promise<SearchAlert[]>;
  /** Watchlist demand: ACTIVE watch-alert count per listing id — the
   *  operator dashboard's "N watching" signal and the public listing
   *  page's social proof read. One grouped query, no N+1. */
  countSearchAlertsByWatch(vertical: string): Promise<Record<string, number>>;
  /** Per-listing RFQ demand: non-spam RFQ count keyed by listing id, for
   *  the operator's own listings — the dashboard's "N requests" chip
   *  (QA-417). One grouped query; spam rows excluded since they're not
   *  demand the operator should see or price against. */
  countRfqsPerListing(
    operatorId: string,
    vertical: string,
  ): Promise<Record<string, number>>;
  /** Buyer-facing track record (QA-431): closed-deal count per operator.
   *  Deals carry no vertical — resolved through quote→rfq so `vertical`
   *  scopes the count to THIS deploy's deals (QA-313 pattern). Batched so
   *  the buyer quotes page pays one grouped read for every card. */
  countDealsPerOperator(
    operatorIds: string[],
    vertical: string,
  ): Promise<Record<string, number>>;
  /** Buyer-facing responsiveness (QA-434): mean hours from the buyer's RFQ
   *  submit to each quote (rfq.createdAt is the right baseline — that's the
   *  request the buyer experienced waiting on). Every quote counts once
   *  regardless of its later status — a declined/withdrawn quote was still
   *  a reply. Missing key = no quotes yet in-vertical (profile hides the
   *  chip rather than showing a fabricated "0h"). Batched like
   *  countDealsPerOperator. */
  avgResponseHoursPerOperator(
    operatorIds: string[],
    vertical: string,
  ): Promise<Record<string, number>>;
  /** Queue a matched listing during the mail cooldown — distinct append. */
  appendSearchAlertPending(alertId: string, listingId: string): Promise<void>;
  /** Stamp lastAlertedAt=now and flush the pending queue (post-send). */
  markSearchAlerted(id: string): Promise<void>;
  /** RFQ rows matching the same filter shape, ignoring limit/offset. */
  countRfqs(filter?: {
    buyerEmail?: string;
    operatorId?: string;
    /** Same "needs a quote" exclusion as listRfqs — pagination totals must
     * match the filtered page (QA-402). */
    needsQuote?: boolean;
    /** Same "dismissed" inclusion as listRfqs (QA-421) — totals must match
     * the filtered page on both impls. */
    dismissedOnly?: boolean;
    /** Same "answered" inclusion as listRfqs (QA-433) — totals must match
     * the filtered page on both impls. */
    answeredOnly?: boolean;
    /** Same per-listing scope as listRfqs (QA-430) — the filtered inbox's
     *  page total. */
    listingId?: string;
    /** Scope to one vertical — matches listRfqs (QA-293). */
    vertical?: string;
    /** Exclude these iface statuses (e.g. "closed" counts only live RFQs). */
    statusNot?: RfqStatus[];
    /** ISO timestamp — only rows created at/after this instant count. */
    since?: string;
    /** Only count concierge-expedited RFQs (admin revenue stat). */
    concierge?: boolean;
  }): Promise<number>;
  /**
   * Delayed fan-out matches not yet due for this operator — RFQs a free-plan
   * operator can't see yet (the Pro "quote first" delay). Feeds inbox upsell
   * copy; terminal RFQs (closed/expired/spam) don't count.
   */
  /** `vertical` scopes the count on a shared DB — a jets teaser must not
   *  include machinery's delayed matches (QA-306). */
  countPendingRfqs(operatorId: string, vertical?: string): Promise<number>;
  /**
   * Expiry sweep: open/quoted rfqs whose `fields.dateTo` (YYYY-MM-DD) is
   * strictly before `cutoff` -> "expired"; their still-"sent" quotes ->
   * "declined". Returns affected counts. `vertical` scopes the sweep on
   * shared-DB deployments (QA-295).
   */
  expireRfqs(
    cutoff: string,
    vertical?: string,
  ): Promise<{ rfqs: number; quotes: number }>;

  createQuote(
    q: Omit<Quote, "id" | "createdAt" | "status" | "updatedAt">,
  ): Promise<Quote>;
  getQuote(id: string): Promise<Quote | undefined>;
  listQuotes(filter?: {
    rfqId?: string;
    operatorId?: string;
    ids?: string[];
    /** Batch-lookup: quotes belonging to any of these RFQs. */
    rfqIds?: string[];
    /** Only rows in this status (QA-424 — the dashboard's open-offers
     *  pipeline reads 'sent' without fetching terminal rows). */
    status?: QuoteStatus;
  }): Promise<Quote[]>;
  /** Quote count for operator stats — avoids an unbounded listQuotes fetch
   *  on the dashboard (QA-151). */
  countQuotes(filter?: {
    operatorId?: string;
    status?: QuoteStatus;
    /** ISO timestamp — only rows created at/after this instant count. */
    since?: string;
  }): Promise<number>;
  /** Atomically transition a quote `expected → status`; returns false (no
   * write) when the current status is not `expected`. Required so concurrent
   * accept/decline/withdraw can't double-mutate (QA-99). */
  setQuoteStatus(
    id: string,
    status: QuoteStatus,
    expected: QuoteStatus,
  ): Promise<boolean>;
  /** Quote revision while the offer is still live (QA-439): CAS-gated
   *  rewrite of amount/currency/message — only a `sent` quote, only its
   *  owner, only while the parent RFQ is live (revising into a dead request
   *  is noise). `createdAt` is untouched so response-time stats can't be
   *  backdated by edits; the buyer sees new terms on next load + an email.
   *  Returns the updated quote, or null when any gate fails. */
  reviseQuote(
    quoteId: string,
    operatorId: string,
    patch: { amount: number; currency: string; message: string },
  ): Promise<Quote | null>;

  /** Job-queue visibility for /admin/jobs (QA-102). Memory mode runs its
   *  fan-out inline — it has no queue, so these are always empty/no-ops. */
  listJobs(filter?: {
    status?: JobInfo["status"];
    /** Owning vertical — shared-DB queues are per-deploy (QA-296). */
    vertical?: string;
    limit?: number;
  }): Promise<JobInfo[]>;
  /** CAS a failed job back to pending (attempts/lastError reset); false unless
   *  the job exists and is currently failed. `vertical` additionally refuses
   *  jobs owned by another vertical (QA-296). */
  retryJob(id: string, vertical?: string): Promise<boolean>;

  createDeal(d: Omit<Deal, "id" | "closedAt">): Promise<Deal>;
  getDeal(id: string): Promise<Deal | undefined>;
  /** `vertical` scopes through deal → quote → rfq (deals carry no vertical
   * column) — admin lists/aggregates must pass it on a shared DB so
   * foreign-vertical deals don't leak into this deploy's ledger (QA-313). */
  listDeals(filter?: {
    operatorId?: string;
    vertical?: string;
    limit?: number;
    offset?: number;
  }): Promise<Deal[]>;
  countDeals(filter?: { operatorId?: string; vertical?: string }): Promise<number>;
  /** All-deals fee aggregate in major units — page-scoped reduces lie once
   * the ledger paginates (QA-171). `vertical` scopes as on listDeals. */
  sumDealFees(filter?: {
    operatorId?: string;
    vertical?: string;
  }): Promise<number>;
  /** Omit `ref` to keep the existing invoiceRef (e.g. invoiced -> paid).
   * `expectedIn` makes the write conditional on the current invoiceStatus —
   * returns false when the deal is already past it (admin void vs provider
   * settle race, QA-145). */
  setDealInvoice(
    id: string,
    status: Deal["invoiceStatus"],
    ref?: string,
    expectedIn?: Deal["invoiceStatus"][],
  ): Promise<boolean>;

  upsertSubscription(s: Omit<Subscription, "id">): Promise<Subscription>;
  getSubscription(operatorId: string): Promise<Subscription | undefined>;
}
