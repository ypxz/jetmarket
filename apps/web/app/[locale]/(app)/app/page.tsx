import { Badge } from "@jetmarket/ui";
import { plans } from "@jetmarket/config";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getVertical } from "@jetmarket/verticals";
import { currentUser } from "@/lib/auth";
import { FREE_LISTING_LIMIT, PRO_PLAN_PRICE_USD } from "@/lib/fees";
import { ListingActions } from "./listing-actions";
import { formatMoney } from "@/lib/format";
import { getRepo } from "@/lib/repo";
import { invoiceStateVariant } from "@/lib/state-variant";
import { isExpiredListing } from "@/lib/search";

export default async function OperatorDashboard() {
  const t = await getTranslations("app.dashboard");
  const tc = await getTranslations("common");
  const vertical = getVertical();
  const vt = await getTranslations(vertical.copy.namespace);
  const listingTypeNames = vertical.listingTypes
    .map((lt) => vt(lt.labelKey))
    .join(", ");
  const user = await currentUser();
  const repo = await getRepo();
  const operator = user ? await repo.getOperatorByUserId(user.id) : undefined;

  if (!operator) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-2xl font-semibold">{t("becomeOperator")}</h1>
        <p className="mt-2 text-muted">{t("becomeOperatorBody")}</p>
        <Link
          href="/app/onboarding"
          className="mt-6 inline-block rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
          data-testid="onboarding-cta"
        >
          {t("createProfile")}
        </Link>
      </main>
    );
  }

  // Cap the dashboard render — the header count uses the true total; beyond
  // 100 listings this page needs a pager, not a longer card wall.
  const [
    listings,
    listingCount,
    deals,
    dealCount,
    openRfqs,
    sub,
    watchCounts,
    rfqCounts,
  ] = await Promise.all([
      repo.listListings({
        operatorId: operator.id,
        vertical: getVertical().slug,
        limit: 100,
      }),
      repo.countOperatorListings(operator.id, getVertical().slug),
      // Success-fee obligations are invisible to operators without this —
      // the admin ledger saw them, the party paying them did not (QA-118).
      repo.listDeals({ operatorId: operator.id, limit: 20 }),
      // Header shows the true total, not the capped page (QA-179).
      repo.countDeals({ operatorId: operator.id }),
      repo.countRfqs({
        operatorId: operator.id,
        vertical: getVertical().slug,
        // Repo impls disagree on the terminal-after-time label (drizzle
        // writes "closed", memory "expired") — exclude both + spam (QA-163).
        statusNot: ["closed", "expired", "spam"],
      }),
      repo.getSubscription(operator.id),
      // Watchlist demand signal (QA-408): one grouped query, chip per row.
      repo.countSearchAlertsByWatch(getVertical().slug),
      // Per-listing RFQ demand (QA-417): same grouped-count shape — "N
      // requests" tells the operator where actual demand already landed.
      repo.countRfqsPerListing(operator.id, getVertical().slug),
    ]);
  // Funnel stats (QA-151): the Pro "analytics" bullet was vaporware — these
  // counts come from real rows, no external vendor needed. Pro-only now —
  // pricing sells analytics as the Pro tier's differentiator (QA-202), so
  // free plans get the gate card instead and skip the count queries.
  const isPro = operator.plan === "pro";
  const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [
    rfqsReceived,
    quotesSent,
    quotesWon,
    quotesLost,
    rfqs30d,
    quotes30d,
    won30d,
  ] = isPro
    ? await Promise.all([
        repo.countRfqs({ operatorId: operator.id, vertical: getVertical().slug }),
        repo.countQuotes({ operatorId: operator.id }),
        repo.countQuotes({ operatorId: operator.id, status: "accepted" }),
        repo.countQuotes({ operatorId: operator.id, status: "declined" }),
        repo.countRfqs({
          operatorId: operator.id,
          vertical: getVertical().slug,
          since: since30d,
        }),
        repo.countQuotes({ operatorId: operator.id, since: since30d }),
        repo.countQuotes({
          operatorId: operator.id,
          status: "accepted",
          since: since30d,
        }),
      ])
    : [0, 0, 0, 0, 0, 0, 0];
  const winRate =
    quotesWon + quotesLost > 0
      ? Math.round((quotesWon / (quotesWon + quotesLost)) * 100)
      : null;
  const limit = isPro ? "∞" : String(FREE_LISTING_LIMIT);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="operator-name">
            {operator.name}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {t("base", {
              icao: operator.baseAirport,
              fleet: operator.fleetSummary || t("fleetTbd"),
            })}{" "}
            {operator.verified ? (
              <span className="text-[color:var(--color-success)]">
                {t("verified")}
              </span>
            ) : (
              <span className="text-[color:var(--color-accent)]">
                {t("unverifiedDelay")}
              </span>
            )}
          </p>
        </div>
        <div className="text-right text-sm">
          <div data-testid="plan-badge" className="font-medium">
            {isPro ? t("proPlan") : t("freePlan")}
          </div>
          <Link
            href="/app/onboarding"
            className="mt-1 inline-block text-primary underline"
            data-testid="edit-profile"
          >
            {t("editProfile")}
          </Link>
          {!isPro ? (
            <Link href="/app/billing" className="text-primary underline">
              {t("upgrade", {
                price: formatMoney(PRO_PLAN_PRICE_USD, plans.pro.currency),
              })}
            </Link>
          ) : null}
        </div>
      </div>

      <section className="mt-8" aria-label={t("statsTitle")}>
        {isPro ? (
          <>
            <dl
              data-testid="operator-stats"
              className="grid grid-cols-2 gap-3 sm:grid-cols-4"
            >
              {(
                [
                  ["statRfqs", rfqsReceived],
                  ["statQuotes", quotesSent],
                  ["statWon", quotesWon],
                  ["statWinRate", winRate === null ? "—" : `${winRate}%`],
                ] as const
              ).map(([key, value]) => (
                <div
                  key={key}
                  className="rounded-md border border-border px-4 py-3"
                >
                  <dt className="text-xs text-muted">{t(key)}</dt>
                  <dd className="mt-1 text-xl font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
            <p
              className="mt-3 text-sm text-muted"
              data-testid="stats-recent"
            >
              {t("statsRecent", {
                rfqs: rfqs30d,
                quotes: quotes30d,
                won: won30d,
              })}
            </p>
          </>
        ) : (
          <div
            data-testid="stats-pro-gate"
            className="rounded-md border border-border px-4 py-3"
          >
            <p className="font-medium">{t("statsProGateTitle")}</p>
            <p className="mt-1 text-sm text-muted">{t("statsProGateBody")}</p>
            <Link
              href="/app/billing"
              className="mt-2 inline-block text-primary underline"
            >
              {t("statsProGateCta")}
            </Link>
          </div>
        )}
      </section>

      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {t("listings", { count: listingCount, limit })}
          </h2>
          <Link
            href="/app/listings/new"
            data-testid="new-listing-cta"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            {t("newListing")}
          </Link>
        </div>
        {listings.length === 0 ? (
          <p className="mt-4 rounded-md border border-dashed border-border p-6 text-sm text-muted">
            {t("noListings", { types: listingTypeNames })}
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-border rounded-md border border-border">
            {listings.map((l) => (
              <li key={l.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <div className="font-medium">{l.title}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    {l.type} · {l.status}
                    {isExpiredListing(l) ? (
                      <Badge variant="warning" className="ml-2">
                        {t("expiredHidden")}
                      </Badge>
                    ) : null}
                    {watchCounts[l.id] ? (
                      <Badge variant="success" className="ml-2">
                        {t("watchers", { count: watchCounts[l.id] ?? 0 })}
                      </Badge>
                    ) : null}
                    {l.views > 0 ? (
                      <Badge variant="outline" className="ml-2">
                        {t("views", { count: l.views })}
                      </Badge>
                    ) : null}
                    {rfqCounts[l.id] ? (
                      <Badge
                        variant="outline"
                        className="ml-2"
                        data-testid={`rfq-count-${l.id}`}
                      >
                        {t("requests", { count: rfqCounts[l.id] ?? 0 })}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium">
                    {formatMoney(l.price, l.currency)}
                  </span>
                  <ListingActions listing={l} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {deals.length > 0 ? (
        <section className="mt-10" data-testid="operator-deals">
          <h2 className="text-lg font-semibold">
            {t("deals", { count: dealCount })}
          </h2>
          <ul className="mt-4 divide-y divide-border rounded-md border border-border">
            {deals.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
              >
                <div>
                  <div className="font-medium">
                    {formatMoney(d.amount, d.currency)} · {t("dealFee", { fee: formatMoney(d.feeAmount, d.currency) })}
                  </div>
                  <div className="text-xs text-muted">
                    {new Date(d.closedAt).toDateString()}
                    {d.invoiceRef ? ` · ${d.invoiceRef}` : ""}
                  </div>
                </div>
                <Badge variant={invoiceStateVariant(d.invoiceStatus)}>
                  {tc(`invoiceState.${d.invoiceStatus}`)}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-10">
        <h2 className="text-lg font-semibold">
          {t("rfqInbox", {
            count: openRfqs,
          })}
        </h2>
        <p className="mt-1 text-sm text-muted">
          <Link href="/app/rfqs" className="text-primary underline">
            {t("openInbox")}
          </Link>
        </p>
      </section>

      {sub ? (
        <p className="mt-10 text-xs text-muted">
          {t("subActive", { date: new Date(sub.currentPeriodEnd).toDateString() })}
        </p>
      ) : null}
    </main>
  );
}
