import { Badge } from "@jetmarket/ui";
import { getLocale, getTranslations } from "next-intl/server";
import { Pager } from "@/components/pager";
import { Link } from "@/i18n/navigation";
import { currentUser } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { getRepo } from "@/lib/repo";
import { operatorRfqView } from "@/lib/rfq-view";
import { SEARCH_PAGE_SIZE, isExpiredListing } from "@/lib/search";
import { quoteStateVariant, rfqStateVariant } from "@/lib/state-variant";
import { verticalConfig, verticalSlug } from "@/lib/vertical";
import { ListingFilter } from "./listing-filter";
import { MarkRfqsSeen } from "./mark-seen";
import { QuoteForm } from "./quote-form";
import { WithdrawButton } from "./withdraw-button";
import { ReviseQuote } from "./revise-quote";
import { AcceptCounter } from "./accept-counter";
import { DeclineCounter } from "./decline-counter";
import { DismissAllButton, DismissButton, RestoreAllButton, RestoreButton } from "./dismiss-button";
import { ReportRfq } from "./report-rfq";

/** RFQ states that still accept quotes — same gate as POST /api/quotes. */
const LIVE_RFQ_STATES = new Set(["open", "matched", "quoted"]);

export default async function RfqInboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await getLocale();
  const params = await searchParams;
  const t = await getTranslations("app.rfqs");
  const tc = await getTranslations("common");
  // Field labels come from the vertical's rfqFields labelKeys — machinery
  // buyers write deliveryPostcode/budgetEur, and raw keys in the inbox are
  // illegible (QA-233). Unknown keys fall back to the raw key.
  const vertical = verticalConfig();
  const vt = await getTranslations(vertical.copy.namespace);
  const fieldLabels = new Map(
    vertical.rfqFields.map((f) => [f.key, vt(f.labelKey)] as const),
  );
  const user = await currentUser();
  const repo = await getRepo();
  const operator = user ? await repo.getOperatorByUserId(user.id) : undefined;
  if (!operator) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <p className="text-muted">{t("needProfile")}</p>
      </main>
    );
  }
  // "Needs a quote" filter (QA-402): only RFQs this operator hasn't quoted
  // yet — the daily-driver view; "all" keeps the full delivered inbox.
  const f = Array.isArray(params.f) ? params.f[0] : params.f;
  const needsOnly = f === "needs";
  // "Dismissed" view (QA-421): the QA-420 exclusion flips to a positive
  // match so dismissed rows can be reviewed + restored.
  const dismissedOnly = f === "dismissed";
  // "Answered" view (QA-433): needsQuote's inverse — the RFQs where this
  // operator already holds a live quote, i.e. their outstanding offers.
  const answeredOnly = f === "answered";
  // "Countered" view (QA-513): the hottest leads — RFQs where this
  // operator's quote carries an unanswered buyer counter.
  const counteredOnly = f === "countered";
  // Per-listing triage (QA-430): only their own listings may filter — a
  // foreign/unknown id falls back to the unfiltered inbox.
  const ownListings = await repo.listListings({
    operatorId: operator.id,
    vertical: verticalSlug(),
    limit: 200,
  });
  const listingParam = Array.isArray(params.listing)
    ? params.listing[0]
    : params.listing;
  const listingFilter = ownListings.some((l) => l.id === listingParam)
    ? listingParam
    : undefined;
  // "Ending first" ordering (QA-443): triage by the QA-442 liveness
  // horizon — soonest-dying requests surface ahead of newer ones.
  const sortParam = Array.isArray(params.sort)
    ? params.sort[0]
    : params.sort;
  const sortEnding = sortParam === "deadline" || undefined;
  const total = await repo.countRfqs({
    operatorId: operator.id,
    listingId: listingFilter,
    needsQuote: needsOnly || undefined,
    dismissedOnly: dismissedOnly || undefined,
    answeredOnly: answeredOnly || undefined,
    counteredOnly: counteredOnly || undefined,
    vertical: verticalSlug(),
  });
  const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  const n = Number(Array.isArray(params.page) ? params.page[0] : params.page);
  const page = Number.isInteger(n) && n >= 1 ? Math.min(n, pages) : 1;
  const rfqsPage = await repo.listRfqs({
    operatorId: operator.id,
    listingId: listingFilter,
    needsQuote: needsOnly || undefined,
    dismissedOnly: dismissedOnly || undefined,
    answeredOnly: answeredOnly || undefined,
    counteredOnly: counteredOnly || undefined,
    vertical: verticalSlug(),
    sort: sortEnding ? "deadline" : undefined,
    limit: SEARCH_PAGE_SIZE,
    offset: (page - 1) * SEARCH_PAGE_SIZE,
  });
  // Batched: one listing lookup + one quotes lookup for the whole page —
  // was 2 queries per row (QA-103). Quotes stay scoped to THIS operator —
  // fan-out matches make other operators' RFQs visible here; their quote
  // amounts must not leak to competitors (QA-73).
  const rfqIds = rfqsPage.map((r) => r.id);
  // pendingRfqs powers the free-plan delayed-RFQ teaser (QA-225) — delayed
  // matches are invisible until due, so the count becomes the upsell.
  const [listingRows, quoteRows, pendingRfqs] = await Promise.all([
    repo.listListings({
      ids: [
        ...new Set(
          rfqsPage
            .map((r) => r.listingId)
            .filter((x): x is string => x !== null),
        ),
      ],
    }),
    repo.listQuotes({ rfqIds, operatorId: operator.id }),
    operator.plan === "free"
      ? repo.countPendingRfqs(operator.id, verticalSlug())
      : 0,
  ]);
  // QA-416 "New" badge: rows created after the last inbox visit (never
  // visited → everything is new). One stamp covers owned + matched
  // deliveries — owned RFQs have no match row by design (self-match is
  // excluded from fan-out).
  const lastSeen = operator.inboxSeenAt;
  const listingById = new Map(listingRows.map((l) => [l.id, l] as const));
  const quotesByRfq = new Map<string, typeof quoteRows>();
  for (const q of quoteRows) {
    const arr = quotesByRfq.get(q.rfqId) ?? [];
    arr.push(q);
    quotesByRfq.set(q.rfqId, arr);
  }
  // Buyer contact fields stay masked pre-deal — the marketplace intro is
  // the fee (QA-152). The buyer's email reaches the winner via email only.
  const rfqDelayHours =
    operator.plan === "free"
      ? (vertical.fees.subscriptionPlans.find((p) => p.rfqDelayHours)
          ?.rfqDelayHours ?? 24)
      : 24;
  const rfqRows = rfqsPage.map((r) => {
    const listing = r.listingId
      ? (listingById.get(r.listingId) ?? null)
      : null;
    return {
      rfq: operatorRfqView(r, listing?.type, vertical),
      listing,
      quotes: quotesByRfq.get(r.id) ?? [],
      // QA-482 "Updated" badge — the request changed since the operator's
      // last inbox visit (never visited → amended since creation). The
      // amend path bumps updatedAt on every content write.
      updated:
        lastSeen === undefined
          ? r.updatedAt > r.createdAt
          : r.updatedAt > lastSeen,
    };
  });
  // QA-438 bulk triage: exactly the rows that offer a per-row DismissButton
  // (live, unquoted — quoted rows keep their context) get swept by one
  // click. The server re-proves every id anyway.
  const dismissableIds = dismissedOnly
    ? []
    : rfqRows
        .filter(({ rfq: r, quotes }) =>
          LIVE_RFQ_STATES.has(r.status) && quotes.length === 0,
        )
        .map(({ rfq: r }) => r.id);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <div
        className="mt-4 flex flex-wrap items-center gap-2"
        data-testid="rfq-filter"
      >
        {(
          [
            ["all", t("filterAll")],
            ["needs", t("filterNeeds")],
            ["answered", t("filterAnswered")],
            ["countered", t("filterCountered")],
            ["dismissed", t("filterDismissed")],
          ] as const
        ).map(([key, label]) => {
          // Listing scope survives view switches — "needs a quote for THIS
          // listing" is the point of the filter (QA-430). An active sort
          // rides along too — the sort toggle preserves the view (QA-443).
          const q = new URLSearchParams();
          if (key !== "all") q.set("f", key);
          if (listingFilter) q.set("listing", listingFilter);
          if (sortEnding) q.set("sort", "deadline");
          const s = q.toString();
          return (
            <Link
              key={key}
              href={`/app/rfqs${s ? `?${s}` : ""}`}
              data-testid={`filter-${key}`}
              className={`rounded-md px-3 py-1.5 text-sm ${
                f === key ||
                (key === "all" &&
                  !needsOnly &&
                  !dismissedOnly &&
                  !answeredOnly &&
                  !counteredOnly)
                  ? "bg-primary text-primary-foreground font-medium"
                  : "border border-border bg-background text-muted"
              }`}
            >
              {label}
            </Link>
          );
        })}
        <ListingFilter
          listings={ownListings.map((l) => ({ id: l.id, title: l.title }))}
          active={listingFilter ?? null}
          f={f ?? null}
          sort={sortEnding ? "deadline" : null}
          allLabel={t("listingFilterAll")}
        />
        {listingFilter ? (
          <Link
            href={`/app/rfqs${(() => {
              const q = new URLSearchParams();
              if (f) q.set("f", f);
              if (sortEnding) q.set("sort", "deadline");
              const s = q.toString();
              return s ? `?${s}` : "";
            })()}`}
            data-testid="listing-filter-clear"
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-muted"
          >
            {t("listingFilterClear")}
          </Link>
        ) : null}
        {(() => {
          // QA-443: soonest-dying first — pairs with the per-row
          // "replies close" label; concierge expedites still outrank.
          const q = new URLSearchParams();
          if (f) q.set("f", f);
          if (listingFilter) q.set("listing", listingFilter);
          if (!sortEnding) q.set("sort", "deadline");
          const s = q.toString();
          return (
            <Link
              href={`/app/rfqs${s ? `?${s}` : ""}`}
              data-testid="sort-ending"
              className={`rounded-md border px-3 py-1.5 text-sm ${
                sortEnding
                  ? "border-border bg-surface font-medium text-foreground"
                  : "border-border bg-background text-muted"
              }`}
            >
              {t("sortEnding")}
            </Link>
          );
        })()}
        {dismissableIds.length > 1 ? (
          <DismissAllButton rfqIds={dismissableIds} />
        ) : null}
        {dismissedOnly && rfqRows.length > 1 ? (
          <RestoreAllButton rfqIds={rfqRows.map(({ rfq: r }) => r.id)} />
        ) : null}
      </div>
      {pendingRfqs > 0 ? (
        <div
          className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface p-4"
          data-testid="delayed-rfq-teaser"
        >
          <p className="text-sm">
            {t("delayedTeaser", { count: pendingRfqs, hours: rfqDelayHours })}
          </p>
          <Link
            href="/app/billing"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            {t("delayedTeaserCta")}
          </Link>
        </div>
      ) : null}
      {total === 0 ? (
        <p className="mt-6 rounded-md border border-dashed border-border p-6 text-sm text-muted" data-testid="rfq-empty">
          {t("empty")}
        </p>
      ) : (
        <ul className="mt-6 space-y-4">
          {rfqRows.map(({ rfq: r, listing, quotes, updated }) => {
            return (
              <li
                key={r.id}
                data-testid={`rfq-${r.id}`}
                className="rounded-md border border-border bg-surface p-4"
              >
                <div className="flex items-center justify-between">
                  <div className="font-medium">
                    {listing?.title ?? t("listingFallback")}
                    {listing && isExpiredListing(listing) ? (
                      <Badge
                        variant="warning"
                        data-testid={`rfq-expired-listing-${r.id}`}
                        className="ml-2"
                      >
                        {t("listingExpired")}
                      </Badge>
                    ) : null}
                  </div>
                  <span className="flex items-center gap-2">
                    {lastSeen === undefined || r.createdAt > lastSeen ? (
                      <Badge variant="warning" data-testid={`rfq-new-${r.id}`}>
                        {t("newBadge")}
                      </Badge>
                    ) : null}
                    {updated ? (
                      <Badge variant="outline" data-testid={`rfq-updated-${r.id}`}>
                        {t("updatedBadge")}
                      </Badge>
                    ) : null}
                    {r.concierge ? (
                      <Badge variant="success" data-testid={`rfq-concierge-${r.id}`}>
                        {t("conciergeBadge")}
                      </Badge>
                    ) : null}
                    <Badge
                      variant={rfqStateVariant(r.status)}
                      data-testid={`rfq-state-${r.id}`}
                    >
                      {tc(`rfqState.${r.status}`)}
                    </Badge>
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted">
                  {t("from", {
                    name: r.buyerName ?? t("anonymousBuyer"),
                    date: new Date(r.createdAt).toLocaleString(locale),
                  })}
                  {LIVE_RFQ_STATES.has(r.status) ? (
                    <span
                      className="ml-2"
                      data-testid={`rfq-deadline-${r.id}`}
                    >
                      ·{" "}
                      {t("repliesClose", {
                        date: new Date(r.deadlineAt).toLocaleDateString(locale,
                          { month: "short", day: "numeric" },
                        ),
                      })}
                    </span>
                  ) : null}
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                  {Object.entries(r.fields).map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <dt className="text-muted">{fieldLabels.get(k) ?? k}:</dt>
                      <dd>{String(v)}</dd>
                    </div>
                  ))}
                </dl>
                {dismissedOnly ? (
                  <div className="mt-3 flex justify-end">
                    {/* QA-421 restore — undismiss returns the RFQ to the
                        normal inbox (DELETE on the dismiss route). */}
                    <RestoreButton rfqId={r.id} />
                  </div>
                ) : quotes.length > 0 ? (
                  <>
                  <ul className="mt-3 space-y-2">
                    {/* QA-510: a declined/withdrawn quote dead-ends the
                        win-back loop — the repo (and route) already allow
                        a fresh offer once no live quote remains, so the
                        form comes back under the history. */}
                    {quotes.map((q) => (
                      <li
                        key={q.id}
                        data-testid={`op-quote-${q.id}`}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                      >
                        <span className="font-medium">
                          {formatMoney(q.amount, q.currency, locale)}
                        </span>
                        <span className="flex items-center gap-2">
                          <Badge
                            variant={quoteStateVariant(q.status)}
                            data-testid={`quote-state-${q.id}`}
                          >
                            {tc(`quoteState.${q.status}`)}
                          </Badge>
                          {q.buyerSeenAt ? (
                            <Badge
                              variant="outline"
                              data-testid={`quote-seen-${q.id}`}
                              title={t("seenByBuyerTitle")}
                            >
                              {t("seenByBuyer")}
                            </Badge>
                          ) : null}
                          {/* QA-508: why the buyer declined — the enum key
                              localizes via app.rfqs.declineReason.* */}
                          {q.status === "declined" && q.declineReason ? (
                            <Badge
                              variant="outline"
                              data-testid={`quote-decline-reason-${q.id}`}
                            >
                              {t(`declineReason.${q.declineReason}`)}
                            </Badge>
                          ) : null}
                          {/* QA-511: the buyer countered — op answers
                              with a revise (which clears the counter). */}
                          {q.status === "sent" && q.counterAmount != null ? (
                            <Badge
                              variant="warning"
                              data-testid={`quote-counter-${q.id}`}
                            >
                              {t("counteredByBuyer", {
                                amount: formatMoney(
                                  q.counterAmount,
                                  q.currency,
                                  locale,
                                ),
                              })}
                            </Badge>
                          ) : null}
                          {/* QA-515: or take their number outright — the
                              deal mints at counterAmount. QA-519: or
                              say no outright — the buyer is told the ask
                              still stands instead of waiting in silence. */}
                          {q.status === "sent" &&
                          q.counterAmount != null &&
                          LIVE_RFQ_STATES.has(r.status) ? (
                            <span className="flex items-center gap-2">
                              <AcceptCounter
                                quoteId={q.id}
                                amount={formatMoney(
                                  q.counterAmount,
                                  q.currency,
                                  locale,
                                )}
                              />
                              <DeclineCounter quoteId={q.id} />
                            </span>
                          ) : null}
                          {q.status === "sent" && LIVE_RFQ_STATES.has(r.status) ? (
                            <>
                              <ReviseQuote
                                quoteId={q.id}
                                // QA-511: answering a counter — the form
                                // opens pre-agreed to the buyer's number.
                                amount={q.counterAmount ?? q.amount}
                                currency={q.currency}
                                message={q.message}
                              />
                              <WithdrawButton quoteId={q.id} />
                            </>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {!quotes.some(
                    (q) => q.status === "sent" || q.status === "accepted",
                  ) && LIVE_RFQ_STATES.has(r.status) ? (
                    <div
                      className="mt-3"
                      data-testid={`requote-${r.id}`}
                    >
                      <QuoteForm rfqId={r.id} />
                    </div>
                  ) : null}
                  {/* QA-472: quoted rows flag too — an op who already
                      quoted an abusive RFQ still needs the signal. */}
                  {LIVE_RFQ_STATES.has(r.status) ? (
                    <div className="mt-2">
                      <ReportRfq rfqId={r.id} />
                    </div>
                  ) : null}
                  </>
                ) : LIVE_RFQ_STATES.has(r.status) ? (
                  <div className="mt-3 flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <QuoteForm rfqId={r.id} />
                      {/* QA-469: flag abuse into admin moderation — the
                          demand-side twin of the buyer listing report. */}
                      <div className="mt-2">
                        <ReportRfq rfqId={r.id} />
                      </div>
                    </div>
                    {/* Dismiss only on rows with no quote history to lose
                        sight of — a quoted row keeps its context (QA-420). */}
                    <DismissButton rfqId={r.id} />
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-muted" data-testid={`rfq-closed-${r.id}`}>
                    {t("notOpen", { status: tc(`rfqState.${r.status}`) })}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Pager
        basePath="/app/rfqs"
        params={params}
        page={page}
        pages={pages}
      />
      {/* QA-416: stamps this visit — a reload only badges newer arrivals. */}
      <MarkRfqsSeen />
    </main>
  );
}
