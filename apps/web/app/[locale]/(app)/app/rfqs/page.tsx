import { Badge } from "@jetmarket/ui";
import { getTranslations } from "next-intl/server";
import { Pager } from "@/components/pager";
import { Link } from "@/i18n/navigation";
import { currentUser } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { getRepo } from "@/lib/repo";
import { operatorRfqView } from "@/lib/rfq-view";
import { SEARCH_PAGE_SIZE } from "@/lib/search";
import { quoteStateVariant, rfqStateVariant } from "@/lib/state-variant";
import { verticalConfig, verticalSlug } from "@/lib/vertical";
import { MarkRfqsSeen } from "./mark-seen";
import { QuoteForm } from "./quote-form";
import { WithdrawButton } from "./withdraw-button";

/** RFQ states that still accept quotes — same gate as POST /api/quotes. */
const LIVE_RFQ_STATES = new Set(["open", "matched", "quoted"]);

export default async function RfqInboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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
  const total = await repo.countRfqs({
    operatorId: operator.id,
    needsQuote: needsOnly || undefined,
    vertical: verticalSlug(),
  });
  const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  const n = Number(Array.isArray(params.page) ? params.page[0] : params.page);
  const page = Number.isInteger(n) && n >= 1 ? Math.min(n, pages) : 1;
  const rfqsPage = await repo.listRfqs({
    operatorId: operator.id,
    needsQuote: needsOnly || undefined,
    vertical: verticalSlug(),
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
    };
  });

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <div className="mt-4 flex gap-2" data-testid="rfq-filter">
        {(
          [
            ["all", t("filterAll")],
            ["needs", t("filterNeeds")],
          ] as const
        ).map(([key, label]) => (
          <Link
            key={key}
            href={key === "needs" ? "/app/rfqs?f=needs" : "/app/rfqs"}
            data-testid={`filter-${key}`}
            className={`rounded-md px-3 py-1.5 text-sm ${
              needsOnly === (key === "needs")
                ? "bg-primary text-primary-foreground font-medium"
                : "border border-border bg-background text-muted"
            }`}
          >
            {label}
          </Link>
        ))}
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
          {rfqRows.map(({ rfq: r, listing, quotes }) => {
            return (
              <li
                key={r.id}
                data-testid={`rfq-${r.id}`}
                className="rounded-md border border-border bg-surface p-4"
              >
                <div className="flex items-center justify-between">
                  <div className="font-medium">{listing?.title ?? t("listingFallback")}</div>
                  <span className="flex items-center gap-2">
                    {lastSeen === undefined || r.createdAt > lastSeen ? (
                      <Badge variant="warning" data-testid={`rfq-new-${r.id}`}>
                        {t("newBadge")}
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
                    date: new Date(r.createdAt).toLocaleString("en-US"),
                  })}
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                  {Object.entries(r.fields).map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <dt className="text-muted">{fieldLabels.get(k) ?? k}:</dt>
                      <dd>{String(v)}</dd>
                    </div>
                  ))}
                </dl>
                {quotes.length > 0 ? (
                  <ul className="mt-3 space-y-2">
                    {quotes.map((q) => (
                      <li
                        key={q.id}
                        data-testid={`op-quote-${q.id}`}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                      >
                        <span className="font-medium">
                          {formatMoney(q.amount, q.currency)}
                        </span>
                        <span className="flex items-center gap-2">
                          <Badge
                            variant={quoteStateVariant(q.status)}
                            data-testid={`quote-state-${q.id}`}
                          >
                            {tc(`quoteState.${q.status}`)}
                          </Badge>
                          {q.status === "sent" && LIVE_RFQ_STATES.has(r.status) ? (
                            <WithdrawButton quoteId={q.id} />
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : LIVE_RFQ_STATES.has(r.status) ? (
                  <QuoteForm rfqId={r.id} />
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
