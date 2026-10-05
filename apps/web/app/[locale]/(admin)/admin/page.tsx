import { Fragment } from "react";
import { CONCIERGE_PRICE_USD } from "@jetmarket/config";
import { Badge } from "@jetmarket/ui";
import { getLocale, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Pager } from "@/components/pager";
import { currentUser } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import type { Deal, Listing } from "@/lib/repo/types";
import { Link } from "@/i18n/navigation";
import { getRepo } from "@/lib/repo";
import { amendmentDiffs } from "@/lib/rfq-amendments";
import { SEARCH_PAGE_SIZE } from "@/lib/search";
import { searchAlertSignature } from "@/lib/search-alerts";
import { invoiceStateVariant } from "@/lib/state-variant";
import { verticalConfig, verticalSlug } from "@/lib/vertical";
import { ListingModButton } from "./listing-mod-button";
import {
  ClearRatingButton,
  MarkPaidButton,
  RevertDealButton,
  VoidInvoiceButton,
} from "./mark-paid";
import { RfqCloseButton, RfqSpamButton } from "./rfq-mod-button";
import { BuyerBlockButton } from "./buyer-block-button";
import { DemandFlushButton } from "./demand-flush";
import {
  DismissDealReportButton,
  DismissQuoteReportButton,
  DismissReportButton,
  DismissRfqReportButton,
} from "./report-dismiss";
import { SuspendButton, VerifyButton } from "./verify-button";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await getLocale();
  const params = await searchParams;
  const t = await getTranslations("admin");
  const tc = await getTranslations("common");
  // QA-538: RFQ-flag detail rows render the request's field map +
  // amendment rungs — labels resolve through the vertical's rfqFields
  // labelKeys like the op inbox (raw key on unknown).
  const vt = await getTranslations(verticalConfig().copy.namespace);
  const fieldLabels = new Map(
    verticalConfig().rfqFields.map((f) => [f.key, vt(f.labelKey)] as const),
  );
  const user = await currentUser();
  if (!user || user.role !== "admin") redirect("/sign-in");

  const repo = await getRepo();
  // Wave 1: everything independent fires together (was 11 serialized
  // round-trips — QA-252).
  const [operatorCount, dealTotal, operators, feeTotal, modListings, modRfqs, conciergeCount, reports, blockedRows, quoteReports, dealReports, modEvents, searchAlerts] =
    await Promise.all([
      repo.countOperators(),
      // Deal ledger is per-vertical like the moderation queues (QA-313).
      repo.countDeals({ vertical: verticalSlug() }),
      repo.listOperators({ limit: 100 }),
      repo.sumDealFees({ vertical: verticalSlug() }),
      // Moderation queues are per-vertical: a shared DB hosts other
      // verticals' rows and admins only govern this deploy's (QA-294).
      repo.listListings({ limit: 50, vertical: verticalSlug() }),
      repo.listRfqs({ limit: 50, vertical: verticalSlug() }),
      // Concierge expedites are platform revenue too — count alongside fees.
      repo.countRfqs({ vertical: verticalSlug(), concierge: true }),
      // QA-461: buyer flags — open reports queue, newest first.
      repo.listListingReports({
        status: "open",
        vertical: verticalSlug(),
        limit: 50,
      }),
      // QA-463: blocked buyer addresses — the RFQ rows show their state.
      repo.listBlockedEmails(),
      // QA-529: buyer quote flags — same open-report queue, second surface.
      repo.listQuoteReports({
        status: "open",
        vertical: verticalSlug(),
        limit: 50,
      }),
      // QA-555: buyer deal flags — the closed-transaction queue.
      repo.listDealReports({
        status: "open",
        vertical: verticalSlug(),
        limit: 50,
      }),
      // QA-467: append-only moderation feed — newest first, this vertical.
      repo.listAdminEvents({ vertical: verticalSlug(), limit: 30 }),
      // QA-562: demand radar — ACTIVE search alerts are buyers saying
      // "I want this and it isn't listed yet". Grouped by param
      // signature below; watch-alerts excluded (they point at a listing
      // that exists — not unmet demand).
      repo.listSearchAlerts({
        vertical: verticalSlug(),
        status: "active",
      }),
    ]);
  const dealPages = Math.max(1, Math.ceil(dealTotal / SEARCH_PAGE_SIZE));
  const rawPage = Number(Array.isArray(params.page) ? params.page[0] : params.page);
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? Math.min(rawPage, dealPages) : 1;
  // Wave 2: the lookups that hang off wave-1 rows.
  const [deals, listingCountRows, modOpRows, rfqListingRows, reportListingRows, reportUserRows, rfqFlagCounts, rfqFlagRows, reportQuoteRows] =
    await Promise.all([
      repo.listDeals({
        limit: SEARCH_PAGE_SIZE,
        offset: (page - 1) * SEARCH_PAGE_SIZE,
        vertical: verticalSlug(),
      }),
      repo.listListingCountsByOperator(
        operators.map((o) => o.id),
        verticalSlug(),
      ),
      repo.listOperators({
        ids: [...new Set(modListings.map((l) => l.operatorId))],
      }),
      repo.listListings({
        ids: [
          ...new Set(
            modRfqs
              .map((r) => r.listingId)
              .filter((x): x is string => x !== null),
          ),
        ],
      }),
      repo.listListings({
        ids: [...new Set(reports.map((r) => r.listingId))],
      }),
      repo.listUsers([...new Set(reports.map((r) => r.reporterId))]),
      // QA-469: operator flags on the RFQ queue — one grouped count per
      // row powers the "flagged ×N" badge (RFQ side of buyer reports).
      repo.countRfqReports(modRfqs.map((r) => r.id)),
      // QA-470: the flag detail behind the badge — reason/note/reporter
      // rows a moderator reads before spam-marking. QA-539: OPEN only —
      // a dismissed flag clears the queue like every report surface.
      repo.listRfqReports({
        status: "open",
        vertical: verticalSlug(),
        limit: 30,
      }),
      // QA-529: quote flag rows join their quote (amount, operator) — the
      // RFQ/listing context resolves in the next wave.
      repo.listQuotes({
        ids: [...new Set(quoteReports.map((r) => r.quoteId))],
      }),
    ]);
  // QA-470: flag rows join their RFQ (status + buyer), the reporter's
  // email, and the RFQ's listing title in one batched wave.
  const [rfqFlagRfqRows, rfqFlagReporterRows, rfqFlagAmendRows] = await Promise.all([
    repo.listRfqs({ ids: [...new Set(rfqFlagRows.map((r) => r.rfqId))] }),
    repo.listUsers([...new Set(rfqFlagRows.map((r) => r.reporterId))]),
    // QA-538: the amendment trail joins too — a "spam" flag is judged
    // partly on whether the buyer rewrote the request after filing.
    repo.listRfqAmendments(rfqFlagRows.map((r) => r.rfqId)),
  ]);
  const rfqFlagAmends = new Map<string, typeof rfqFlagAmendRows>();
  for (const a of rfqFlagAmendRows) {
    const arr = rfqFlagAmends.get(a.rfqId) ?? [];
    arr.push(a);
    rfqFlagAmends.set(a.rfqId, arr);
  }
  const rfqFlagListingRows = await repo.listListings({
    ids: [
      ...new Set(
        rfqFlagRfqRows
          .map((r) => r.listingId)
          .filter((x): x is string => x !== null),
      ),
    ],
  });
  // QA-529 wave-3 joins: quote-flag rows resolve the request (title,
  // buyer) and the flagged operator in one batched pass.
  // QA-535: the revision ladder joins too — a moderator judging an
  // "off_platform" flag needs the flagged message AND whether the op
  // rewrote it after filing (each rung carries the superseded text).
  const [reportQuoteRfqRows, reportQuoteOpRows, reportQuoteRevRows] = await Promise.all([
    repo.listRfqs({ ids: [...new Set(reportQuoteRows.map((q) => q.rfqId))] }),
    repo.listOperators({
      ids: [...new Set(reportQuoteRows.map((q) => q.operatorId))],
    }),
    repo.listQuoteRevisions(reportQuoteRows.map((q) => q.id)),
  ]);
  // QA-555: deal-flag rows join their deal (amount, invoice, operator) —
  // the deal already carries buyerEmail so no rfq hop is needed here.
  const reportDealRows = await repo.listDeals({
    ids: [...new Set(dealReports.map((r) => r.dealId))],
  });
  const reportDealOpRows = await repo.listOperators({
    ids: [...new Set(reportDealRows.map((d) => d.operatorId))],
  });
  const reportDeals = new Map(reportDealRows.map((d) => [d.id, d] as const));
  const reportDealOps = new Map(
    reportDealOpRows.map((o) => [o.id, o] as const),
  );
  const reportQuoteListingRows = await repo.listListings({
    ids: [
      ...new Set(
        reportQuoteRfqRows
          .map((r) => r.listingId)
          .filter((x): x is string => x !== null),
      ),
    ],
  });
  const rfqFlagRfqs = new Map(rfqFlagRfqRows.map((r) => [r.id, r] as const));
  const rfqFlagListings = new Map(
    rfqFlagListingRows.map((l) => [l.id, l.title] as const),
  );
  const rfqFlagEmails = new Map(
    rfqFlagReporterRows.map((u) => [u.id, u.email] as const),
  );
  // QA-467: audit rows show who did it — resolve admin emails in one go.
  const modEventUserRows = await repo.listUsers([
    ...new Set(
      modEvents.map((e) => e.adminId).filter((x): x is string => !!x),
    ),
  ]);
  // Report rows reach through their listing to the operator — the row's
  // enforcement buttons (suspend/moderate) need the owner row (QA-462).
  const reportOpRows = await repo.listOperators({
    ids: [...new Set(reportListingRows.map((l) => l.operatorId))],
  });
  // One grouped query + one Map build — was 100 sequential counts (QA-100).
  const listingCounts = new Map(Object.entries(listingCountRows));
  // Deal rows resolve operator names in ONE query — the first-100 table page
  // doesn't necessarily contain a deal's operator (QA-100).
  const dealOpRows = await repo.listOperators({
    ids: [...new Set(deals.map((d) => d.operatorId))],
  });
  const operatorNames = new Map(dealOpRows.map((o) => [o.id, o.name] as const));
  const dealOps = new Map(
    deals.map((d) => [d.id, operatorNames.get(d.operatorId) ?? "?"] as const),
  );
  // One deployment = one vertical = one currency; the aggregate is honest
  // only in that currency (rows still print their own d.currency).
  // sumDealFees is a real all-deals aggregate — a page-scoped reduce would
  // understate "fees" once the ledger paginates (QA-171).
  const siteCurrency = verticalConfig().currency;

  // Listing moderation (QA-157): newest 50 across live states — the takedown
  // targets are active/paused listings, not drafts or already-archived rows.
  const modOpNames = new Map(modOpRows.map((o) => [o.id, o.name] as const));

  // RFQ moderation (QA-181): newest 50 across all states — spam lands in
  // operator inboxes until an admin bins it. listing_id is set-null on
  // listing delete, so titles resolve via a batch lookup with a fallback.
  const rfqListingTitles = new Map(
    rfqListingRows.map((l) => [l.id, l.title] as const),
  );
  // QA-461: report rows resolve their listing title + reporter email in
  // batch — no per-row lookups.
  const reportListings = new Map(reportListingRows.map((l) => [l.id, l] as const));
  const reportOps = new Map(reportOpRows.map((o) => [o.id, o] as const));
  const reportEmails = new Map(
    reportUserRows.map((u) => [u.id, u.email] as const),
  );
  const modEventEmails = new Map(
    modEventUserRows.map((u) => [u.id, u.email] as const),
  );
  // QA-529: flag row -> quote -> rfq/listing/operator maps (batch, no
  // per-row lookups).
  const reportQuotes = new Map(
    reportQuoteRows.map((q) => [q.id, q] as const),
  );
  const reportQuoteRfqs = new Map(
    reportQuoteRfqRows.map((r) => [r.id, r] as const),
  );
  const reportQuoteListings = new Map(
    reportQuoteListingRows.map((l) => [l.id, l] as const),
  );
  const reportQuoteOps = new Map(
    reportQuoteOpRows.map((o) => [o.id, o] as const),
  );
  const reportQuoteRevs = new Map<string, typeof reportQuoteRevRows>();
  for (const rev of reportQuoteRevRows) {
    const rungs = reportQuoteRevs.get(rev.quoteId) ?? [];
    rungs.push(rev);
    reportQuoteRevs.set(rev.quoteId, rungs);
  }
  const LIVE_RFQ: ReadonlySet<string> = new Set(["open", "matched", "quoted"]);
  const blockedEmails = new Set(
    blockedRows.map((b) => b.email.toLowerCase()),
  );

  // QA-552: operator drill-down — ?op=<id> renders a moderation detail
  // card above the table: the fields a moderator checks before a
  // verify/suspend decision. Flag counts reuse the already-loaded open
  // queues (they are "on the queue right now" figures, not history).
  const opParam = typeof params.op === "string" ? params.op : undefined;
  const detailOp = opParam ? await repo.getOperator(opParam) : undefined;
  let opDetail:
    | {
        email?: string;
        listings: Listing[];
        bookLive: number;
        bookTotal: number;
        deals: Deal[];
        dealCount: number;
        dealFees: number;
        rating?: { avg: number; count: number };
        flags: { listings: number; quotes: number; filed: number };
      }
    | undefined;
  if (opParam && detailOp) {
    const [opUsers, opListings, opLiveRows, opBookTotal, opDeals, opDealCount, opDealFees, opRating] =
      await Promise.all([
        repo.listUsers([detailOp.userId]),
        repo.listListings({
          operatorId: detailOp.id,
          vertical: verticalSlug(),
          limit: 10,
        }),
        repo.listListingCountsByOperator([detailOp.id], verticalSlug()),
        repo.countListings({
          operatorId: detailOp.id,
          vertical: verticalSlug(),
        }),
        repo.listDeals({
          operatorId: detailOp.id,
          vertical: verticalSlug(),
          limit: 6,
        }),
        repo.countDeals({
          operatorId: detailOp.id,
          vertical: verticalSlug(),
        }),
        repo.sumDealFees({
          operatorId: detailOp.id,
          vertical: verticalSlug(),
        }),
        repo.ratingSummaryPerOperator([detailOp.id]),
      ]);
    opDetail = {
      email: opUsers[0]?.email,
      listings: opListings,
      bookLive: opLiveRows[detailOp.id] ?? 0,
      bookTotal: opBookTotal,
      deals: opDeals,
      dealCount: opDealCount,
      dealFees: opDealFees,
      rating: opRating[detailOp.id],
      flags: {
        listings: reports.filter(
          (r) => reportListings.get(r.listingId)?.operatorId === detailOp.id,
        ).length,
        quotes: quoteReports.filter(
          (r) => reportQuotes.get(r.quoteId)?.operatorId === detailOp.id,
        ).length,
        filed: rfqFlagRows.filter((r) => r.reporterId === detailOp.userId)
          .length,
      },
    };
  }

  // QA-562: group ACTIVE param-alerts by their search signature — N
  // buyers waiting on the same unlisted demand. Watch-alerts excluded
  // (they point at an existing listing). Sorted by unmet backlog, then
  // subscribers, so the hungriest gap reads first.
  const demandGroups = (() => {
    const groups = new Map<
      string,
      { signature: string; buyers: number; backlog: number; newest: string }
    >();
    for (const a of searchAlerts) {
      const signature = searchAlertSignature(a.params);
      const key = signature || "(any)";
      const g = groups.get(key) ?? {
        signature,
        buyers: 0,
        backlog: 0,
        newest: a.createdAt,
      };
      g.buyers += 1;
      g.backlog += a.pendingIds.length;
      if (a.createdAt > g.newest) g.newest = a.createdAt;
      groups.set(key, g);
    }
    return [...groups.values()].sort(
      (a, b) => b.backlog - a.backlog || b.buyers - a.buyers,
    );
  })();

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm">
        <Link href="/admin/jobs" className="text-muted underline">
          {t("viewJobs")}
        </Link>
      </p>

      {opParam && detailOp === undefined ? (
        <p className="mt-4 text-sm text-muted" data-testid="op-not-found">
          {t("opNotFound", { id: opParam })}
        </p>
      ) : null}
      {detailOp && opDetail ? (
        <section
          id="op-detail"
          data-testid="op-detail"
          className="mt-6 rounded-lg border border-border bg-surface p-4"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">
              {t("opDetail")} — {detailOp.name}
            </h2>
            <Link href="/admin" className="text-sm text-muted underline">
              {t("backToOps")}
            </Link>
          </div>
          <p className="mt-1 text-sm text-muted" data-testid="op-detail-meta">
            <span data-testid="op-detail-email">{opDetail.email ?? "—"}</span>
            {" · "}
            {detailOp.baseAirport}
            {" · "}
            {detailOp.plan}
            {" · "}
            {t("colJoined")}{" "}
            {new Date(detailOp.createdAt).toLocaleDateString(locale)}
          </p>
          <p className="mt-2 flex flex-wrap gap-1 text-sm">
            <Badge variant={detailOp.verified ? "success" : "outline"}>
              {detailOp.verified ? tc("verified") : tc("unverified")}
            </Badge>
            {detailOp.suspended ? (
              <Badge variant="danger">{t("suspendedBadge")}</Badge>
            ) : null}
            <Badge variant="outline">
              {detailOp.acceptingRfqs ? t("opReceivingRfqs") : t("opAway")}
            </Badge>
            {!detailOp.notifyRfqMatch ? (
              <Badge variant="outline">{t("opMailMuted")}</Badge>
            ) : null}
          </p>
          <p className="mt-2 text-sm" data-testid="op-detail-rating">
            {opDetail.rating
              ? t("opRatingLine", {
                  avg: opDetail.rating.avg.toFixed(1),
                  count: opDetail.rating.count,
                })
              : t("opNoRating")}
          </p>
          <p className="mt-1 text-sm" data-testid="op-detail-book">
            {t("opBookLine", {
              total: opDetail.bookTotal,
              live: opDetail.bookLive,
            })}
          </p>
          <p className="mt-1 text-sm" data-testid="op-detail-flags">
            {t("opFlagsLine", {
              listings: opDetail.flags.listings,
              quotes: opDetail.flags.quotes,
              filed: opDetail.flags.filed,
            })}
          </p>

          <h3 className="mt-4 text-sm font-semibold">
            {t("listings", { count: opDetail.bookTotal })}
          </h3>
          <table className="mt-1 w-full text-left text-sm">
            <tbody className="divide-y divide-border">
              {opDetail.listings.map((l) => (
                <tr key={l.id} data-testid={`op-listing-${l.id}`}>
                  <td className="py-1 pr-4 font-medium">{l.title}</td>
                  <td className="py-1 pr-4">{l.type}</td>
                  <td className="py-1 pr-4">{l.status}</td>
                  <td className="py-1 text-muted">
                    {new Date(l.createdAt).toLocaleDateString(locale)}
                  </td>
                </tr>
              ))}
              {opDetail.listings.length === 0 ? (
                <tr>
                  <td className="py-2 text-muted">{t("noListings")}</td>
                </tr>
              ) : null}
            </tbody>
          </table>

          <h3 className="mt-4 text-sm font-semibold">
            {t("ledger", {
              count: opDetail.dealCount,
              total: formatMoney(opDetail.dealFees, siteCurrency, locale),
            })}
          </h3>
          <table className="mt-1 w-full text-left text-sm">
            <tbody className="divide-y divide-border">
              {opDetail.deals.map((d) => (
                <tr key={d.id} data-testid={`op-deal-${d.id}`}>
                  <td className="py-1 pr-4 font-mono text-xs">{d.id}</td>
                  <td className="py-1 pr-4">{d.buyerEmail ?? "—"}</td>
                  <td className="py-1 pr-4">
                    {formatMoney(d.feeAmount, d.currency, locale)}
                  </td>
                  <td className="py-1 pr-4">
                    <Badge variant={invoiceStateVariant(d.invoiceStatus)}>
                      {tc(`invoiceState.${d.invoiceStatus}`)}
                    </Badge>
                  </td>
                  <td className="py-1 pr-4">
                    {d.buyerRating !== undefined ? `★ ${d.buyerRating}` : "—"}
                  </td>
                  <td className="py-1 text-muted">
                    {new Date(d.closedAt).toLocaleDateString(locale)}
                  </td>
                </tr>
              ))}
              {opDetail.deals.length === 0 ? (
                <tr>
                  <td className="py-2 text-muted">{t("noDeals")}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="text-lg font-semibold">
          {t("operators", { count: operatorCount })}
        </h2>
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-xl text-left text-sm">
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 pr-4">{t("colName")}</th>
              <th className="py-2 pr-4">{t("colBase")}</th>
              <th className="py-2 pr-4">{t("colPlan")}</th>
              <th className="py-2 pr-4">{t("colListings")}</th>
              <th className="py-2 pr-4">{t("colVerified")}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {operators.map((o) => (
              <tr key={o.id} data-testid={`admin-op-${o.id}`}>
                <td className="py-2 pr-4 font-medium">
                  <Link
                    href={`/admin?op=${o.id}#op-detail`}
                    className="underline"
                    title={t("viewOperator")}
                    data-testid={`op-view-${o.id}`}
                  >
                    {o.name}
                  </Link>
                </td>
                <td className="py-2 pr-4">{o.baseAirport}</td>
                <td className="py-2 pr-4">{o.plan}</td>
                <td className="py-2 pr-4">{listingCounts.get(o.id) ?? 0}</td>
                <td className="py-2 pr-4" data-testid={`admin-verified-${o.id}`}>
                  {o.verified ? t("yes") : t("no")}
                  {o.suspended ? (
                    <Badge variant="danger" data-testid={`admin-suspended-${o.id}`}>
                      {t("suspendedBadge")}
                    </Badge>
                  ) : null}
                </td>
                <td className="py-2">
                  <span className="inline-flex gap-1">
                    <VerifyButton operatorId={o.id} verified={o.verified} />
                    <SuspendButton operatorId={o.id} suspended={o.suspended} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">
          {t("ledger", {
            count: dealTotal,
            total: formatMoney(feeTotal, siteCurrency, locale),
          })}
        </h2>
        <p className="mt-1 text-sm text-muted" data-testid="admin-concierge-stat">
          {t("concierge", {
            count: conciergeCount,
            total: formatMoney(CONCIERGE_PRICE_USD * conciergeCount, "USD", locale),
          })}
        </p>
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-2xl text-left text-sm" data-testid="fee-ledger">
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 pr-4">{t("colDeal")}</th>
              <th className="py-2 pr-4">{t("colOperator")}</th>
              <th className="py-2 pr-4">{t("colBuyer")}</th>
              <th className="py-2 pr-4">{t("colAmount")}</th>
              <th className="py-2 pr-4">{t("colFeePct")}</th>
              <th className="py-2 pr-4">{t("colFee")}</th>
              <th className="py-2 pr-4">{t("colInvoice")}</th>
              <th className="py-2 pr-4">{t("colRating")}</th>
              <th className="py-2">{t("colClosed")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {deals.map((d) => (
              <tr key={d.id} data-testid={`deal-${d.id}`}>
                <td className="py-2 pr-4 font-mono text-xs">{d.id}</td>
                <td className="py-2 pr-4">{dealOps.get(d.id)}</td>
                <td className="py-2 pr-4" data-testid={`deal-buyer-${d.id}`}>{d.buyerEmail ?? "—"}</td>
                <td className="py-2 pr-4">{formatMoney(d.amount, d.currency, locale)}</td>
                <td className="py-2 pr-4">{(d.feePct * 100).toFixed(1)}%</td>
                <td className="py-2 pr-4 font-medium">{formatMoney(d.feeAmount, d.currency, locale)}</td>
                <td className="py-2 pr-4" data-testid={`deal-invoice-${d.id}`}>
                  <Badge variant={invoiceStateVariant(d.invoiceStatus)}>
                    {tc(`invoiceState.${d.invoiceStatus}`)}
                  </Badge>
                  {d.invoiceRef ? (
                    <span className="ml-1 font-mono text-xs text-muted">
                      {d.invoiceRef}
                    </span>
                  ) : null}
                  {d.invoiceStatus === "invoiced" ? (
                    <MarkPaidButton dealId={d.id} />
                  ) : null}
                  {d.invoiceStatus === "pending" || d.invoiceStatus === "invoiced" ? (
                    <VoidInvoiceButton dealId={d.id} />
                  ) : null}
                  {/* QA-550: sale fell through — void the fee + free the
                      consumed one-off. Paid rows can't revert (money moved;
                      refund outside the app first). */}
                  {d.invoiceStatus !== "paid" ? (
                    <RevertDealButton dealId={d.id} />
                  ) : null}
                </td>
                <td className="py-2 pr-4" data-testid={`deal-rating-${d.id}`}>
                  {d.buyerRating !== undefined ? (
                    <>
                      <Badge variant="outline">★ {d.buyerRating}</Badge>{" "}
                      <ClearRatingButton dealId={d.id} />
                    </>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="py-2 text-muted">{new Date(d.closedAt).toLocaleDateString(locale)}</td>
              </tr>
            ))}
            {deals.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-6 text-center text-muted">
                  {t("noDeals")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table></div>
        <Pager
          basePath="/admin"
          params={params}
          page={page}
          pages={dealPages}
        />
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">
          {t("listings", { count: modListings.length })}
        </h2>
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-2xl text-left text-sm">
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 pr-4">{t("colTitle")}</th>
              <th className="py-2 pr-4">{t("colOperator")}</th>
              <th className="py-2 pr-4">{t("colType")}</th>
              <th className="py-2 pr-4">{t("colStatus")}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {modListings.map((l) => (
              <tr key={l.id} data-testid={`admin-listing-${l.id}`}>
                <td className="py-2 pr-4 font-medium">{l.title}</td>
                <td className="py-2 pr-4">{modOpNames.get(l.operatorId) ?? "?"}</td>
                <td className="py-2 pr-4">{l.type}</td>
                <td className="py-2 pr-4" data-testid={`admin-listing-status-${l.id}`}>
                  {l.status}
                </td>
                <td className="flex gap-2 py-2">
                  <ListingModButton listingId={l.id} status={l.status} action="paused" />
                  <ListingModButton listingId={l.id} status={l.status} action="archived" />
                </td>
              </tr>
            ))}
            {modListings.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-6 text-center text-muted">
                  {t("noListings")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table></div>
      </section>

      <section className="mt-10" data-testid="admin-reports">
        <h2 className="text-lg font-semibold">
          {t("reports", { count: reports.length })}
        </h2>
        {reports.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{t("noReports")}</p>
        ) : (
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-2xl text-left text-sm">
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 pr-4">{t("colTitle")}</th>
              <th className="py-2 pr-4">{t("colOperator")}</th>
              <th className="py-2 pr-4">{t("colReason")}</th>
              <th className="py-2 pr-4">{t("colNote")}</th>
              <th className="py-2 pr-4">{t("colReporter")}</th>
              <th className="py-2 pr-4">{t("colFiled")}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {reports.map((r) => (
              <tr key={r.id} data-testid={`report-${r.id}`}>
                <td className="py-2 pr-4 font-medium">
                  {reportListings.get(r.listingId)?.title ?? "—"}
                </td>
                <td className="py-2 pr-4">
                  {reportListings.get(r.listingId)?.operatorId
                    ? (reportOps.get(reportListings.get(r.listingId)!.operatorId)
                        ?.name ?? "—")
                    : "—"}
                </td>
                <td className="py-2 pr-4">
                  <Badge variant="warning" data-testid={`report-reason-${r.id}`}>
                    {r.reason}
                  </Badge>
                </td>
                <td className="max-w-60 truncate py-2 pr-4">{r.note ?? ""}</td>
                <td className="py-2 pr-4">
                  {reportEmails.get(r.reporterId) ?? "—"}
                </td>
                <td className="py-2 pr-4">
                  {new Date(r.createdAt).toLocaleDateString(locale)}
                </td>
                <td className="py-2">
                  <span className="inline-flex gap-1">
                    {reportListings.get(r.listingId) ? (
                      <>
                        <ListingModButton
                          listingId={r.listingId}
                          status={reportListings.get(r.listingId)!.status}
                          action="paused"
                        />
                        <ListingModButton
                          listingId={r.listingId}
                          status={reportListings.get(r.listingId)!.status}
                          action="archived"
                        />
                      </>
                    ) : null}
                    {reportListings.get(r.listingId)?.operatorId ? (
                      <SuspendButton
                        operatorId={reportListings.get(r.listingId)!.operatorId}
                        suspended={
                          reportOps.get(
                            reportListings.get(r.listingId)!.operatorId,
                          )?.suspended ?? false
                        }
                      />
                    ) : null}
                    {/* QA-558: every flag queue carries the reporter-block
                        kill — serial flag-abuse answers from any queue. */}
                    {reportEmails.get(r.reporterId) ? (
                      <BuyerBlockButton
                        email={reportEmails.get(r.reporterId)!}
                        blocked={blockedEmails.has(
                          reportEmails.get(r.reporterId)!.toLowerCase(),
                        )}
                      />
                    ) : null}
                    <DismissReportButton reportId={r.id} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
        )}
      </section>

      {/* QA-529: buyer flags on received quotes — the fee-circumvention
          / abuse queue, resolved through quote → rfq → listing. */}
      <section className="mt-10" data-testid="admin-quote-reports">
        <h2 className="text-lg font-semibold">
          {t("quoteReports", { count: quoteReports.length })}
        </h2>
        {quoteReports.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{t("noQuoteReports")}</p>
        ) : (
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-2xl text-left text-sm">
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 pr-4">{t("colQuote")}</th>
              <th className="py-2 pr-4">{t("colOnRfq")}</th>
              <th className="py-2 pr-4">{t("colOperator")}</th>
              <th className="py-2 pr-4">{t("colReason")}</th>
              <th className="py-2 pr-4">{t("colNote")}</th>
              <th className="py-2 pr-4">{t("colReporter")}</th>
              <th className="py-2 pr-4">{t("colFiled")}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {quoteReports.map((r) => {
              const q = reportQuotes.get(r.quoteId);
              const rfq = q ? reportQuoteRfqs.get(q.rfqId) : undefined;
              const listing = rfq?.listingId
                ? reportQuoteListings.get(rfq.listingId)
                : undefined;
              const op = q ? reportQuoteOps.get(q.operatorId) : undefined;
              const revs = q ? reportQuoteRevs.get(q.id) : undefined;
              return (
              <Fragment key={r.id}>
              <tr data-testid={`quote-report-${r.id}`}>
                <td className="py-2 pr-4 font-medium">
                  {q ? formatMoney(q.amount, q.currency, locale) : "—"}
                </td>
                <td className="py-2 pr-4">{listing?.title ?? "—"}</td>
                <td className="py-2 pr-4">{op?.name ?? "—"}</td>
                <td className="py-2 pr-4">
                  <Badge variant="warning" data-testid={`quote-report-reason-${r.id}`}>
                    {r.reason}
                  </Badge>
                </td>
                <td className="max-w-60 truncate py-2 pr-4">{r.note ?? ""}</td>
                <td className="py-2 pr-4" data-testid={`quote-report-reporter-${r.id}`}>
                  {r.reporterEmail}
                </td>
                <td className="py-2 pr-4">
                  {new Date(r.createdAt).toLocaleDateString(locale)}
                </td>
                <td className="py-2">
                  <span className="inline-flex gap-1">
                    {q ? (
                      <SuspendButton
                        operatorId={q.operatorId}
                        suspended={op?.suspended ?? false}
                      />
                    ) : null}
                    <BuyerBlockButton
                      email={r.reporterEmail}
                      blocked={blockedEmails.has(
                        r.reporterEmail.toLowerCase(),
                      )}
                    />
                    <DismissQuoteReportButton reportId={r.id} />
                  </span>
                </td>
              </tr>
              {/* Moderation needs the flagged text, not just the flag:
                  the full message plus every superseded revision
                  (each rung carries the pre-revise terms) — QA-535. */}
              <tr data-testid={`quote-report-detail-${r.id}`}>
                <td colSpan={8} className="pb-4 pt-0">
                  {q?.message ? (
                    <p
                      className="text-sm"
                      data-testid={`quote-report-msg-${r.id}`}
                    >
                      {q.message}
                    </p>
                  ) : null}
                  {revs && revs.length > 0 ? (
                    <ul
                      className="mt-1 space-y-0.5 text-xs text-muted"
                      data-testid={`quote-report-revs-${r.id}`}
                    >
                      {revs.map((rev) => (
                        <li key={rev.id} data-testid={`quoterev-${rev.id}`}>
                          {t("revLine", {
                            amount: formatMoney(rev.amount, rev.currency, locale),
                            date: new Date(rev.supersededAt).toLocaleDateString(locale),
                          })}
                          {rev.message ? ` — ${rev.message}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </td>
              </tr>
              </Fragment>
              );
            })}
          </tbody>
        </table></div>
        )}
      </section>

      {/* QA-555: buyer flags on closed deals — the entity where money
          already moved; moderation context is the deal itself (amount,
          invoice state, operator) resolved in one batched join. */}
      <section className="mt-10" data-testid="admin-deal-reports">
        <h2 className="text-lg font-semibold">
          {t("dealReports", { count: dealReports.length })}
        </h2>
        {dealReports.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{t("noDealReports")}</p>
        ) : (
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-2xl text-left text-sm">
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 pr-4">{t("colDeal")}</th>
              <th className="py-2 pr-4">{t("colAmount")}</th>
              <th className="py-2 pr-4">{t("colInvoice")}</th>
              <th className="py-2 pr-4">{t("colOperator")}</th>
              <th className="py-2 pr-4">{t("colReason")}</th>
              <th className="py-2 pr-4">{t("colNote")}</th>
              <th className="py-2 pr-4">{t("colReporter")}</th>
              <th className="py-2 pr-4">{t("colFiled")}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {dealReports.map((r) => {
              const d = reportDeals.get(r.dealId);
              const op = d ? reportDealOps.get(d.operatorId) : undefined;
              return (
              <tr key={r.id} data-testid={`deal-report-${r.id}`}>
                <td className="py-2 pr-4 font-mono text-xs" data-testid={`deal-report-deal-${r.id}`}>
                  {d?.id ?? r.dealId}
                </td>
                <td className="py-2 pr-4 font-medium">
                  {d ? formatMoney(d.amount, d.currency, locale) : "—"}
                </td>
                <td className="py-2 pr-4" data-testid={`deal-report-invoice-${r.id}`}>
                  {d ? (
                    <Badge variant={invoiceStateVariant(d.invoiceStatus)}>
                      {tc(`invoiceState.${d.invoiceStatus}`)}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="py-2 pr-4" data-testid={`deal-report-op-${r.id}`}>
                  {op ? (
                    <Link
                      href={`/admin?op=${op.id}#op-detail`}
                      className="underline underline-offset-2"
                    >
                      {op.name}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="py-2 pr-4">
                  <Badge variant="warning" data-testid={`deal-report-reason-${r.id}`}>
                    {r.reason}
                  </Badge>
                </td>
                <td className="max-w-60 truncate py-2 pr-4">{r.note ?? ""}</td>
                <td className="py-2 pr-4" data-testid={`deal-report-reporter-${r.id}`}>
                  {r.reporterEmail}
                </td>
                <td className="py-2 pr-4">
                  {new Date(r.createdAt).toLocaleDateString(locale)}
                </td>
                <td className="py-2">
                  {/* QA-556: the flag row IS the triage — a 'no_service'
                      report is the revert case (QA-550), and serial abuse
                      answers the same sanctions every queue carries. */}
                  <span className="inline-flex gap-1">
                    {d && d.invoiceStatus !== "paid" ? (
                      <RevertDealButton dealId={d.id} />
                    ) : null}
                    {op ? (
                      <SuspendButton
                        operatorId={op.id}
                        suspended={op.suspended ?? false}
                      />
                    ) : null}
                    <BuyerBlockButton
                      email={r.reporterEmail}
                      blocked={blockedEmails.has(
                        r.reporterEmail.toLowerCase(),
                      )}
                    />
                    <DismissDealReportButton reportId={r.id} />
                  </span>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table></div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">
          {t("rfqs", { count: modRfqs.length })}
        </h2>
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-2xl text-left text-sm">
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 pr-4">{t("colBuyer")}</th>
              <th className="py-2 pr-4">{t("colListing")}</th>
              <th className="py-2 pr-4">{t("colStatus")}</th>
              <th className="py-2 pr-4">{t("colCreated")}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {modRfqs.map((r) => (
              <tr key={r.id} data-testid={`admin-rfq-${r.id}`}>
                <td className="py-2 pr-4 font-medium">{r.buyerEmail}</td>
                <td className="py-2 pr-4">
                  {(r.listingId ? rfqListingTitles.get(r.listingId) : undefined) ?? "—"}
                </td>
                <td className="py-2 pr-4" data-testid={`admin-rfq-status-${r.id}`}>
                  {r.status}
                  {r.concierge ? (
                    <Badge
                      variant="success"
                      className="ml-1"
                      data-testid={`admin-rfq-concierge-${r.id}`}
                    >
                      {t("conciergeBadge")}
                    </Badge>
                  ) : null}
                  {(rfqFlagCounts[r.id] ?? 0) > 0 ? (
                    <Badge
                      variant="warning"
                      className="ml-1"
                      data-testid={`admin-rfq-flagged-${r.id}`}
                    >
                      {t("rfqFlagged", { count: rfqFlagCounts[r.id] ?? 0 })}
                    </Badge>
                  ) : null}
                </td>
                <td className="py-2 pr-4 text-muted">
                  {new Date(r.createdAt).toLocaleDateString(locale)}
                </td>
                <td className="py-2">
                  <span className="inline-flex gap-1">
                    {LIVE_RFQ.has(r.status) ? (
                      <>
                        <RfqSpamButton rfqId={r.id} />
                        <RfqCloseButton rfqId={r.id} />
                      </>
                    ) : null}
                    <BuyerBlockButton
                      email={r.buyerEmail}
                      blocked={blockedEmails.has(r.buyerEmail.toLowerCase())}
                    />
                  </span>
                </td>
              </tr>
            ))}
            {modRfqs.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-6 text-center text-muted">
                  {t("noRfqs")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table></div>
      </section>

      {/* QA-470: the flag detail behind each RFQ row's "flagged ×N" badge —
          reason/note/reporter for the moderator's spam call. Read-only:
          enforcement stays on the RFQ row (spam-mark, buyer block). */}
      <section className="mt-10" data-testid="admin-rfq-reports">
        <h2 className="text-lg font-semibold">
          {t("rfqReports", { count: rfqFlagRows.length })}
        </h2>
        {rfqFlagRows.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{t("noRfqReports")}</p>
        ) : (
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-2xl text-left text-sm">
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 pr-4">{t("colBuyer")}</th>
              <th className="py-2 pr-4">{t("colListing")}</th>
              <th className="py-2 pr-4">{t("colStatus")}</th>
              <th className="py-2 pr-4">{t("colReason")}</th>
              <th className="py-2 pr-4">{t("colNote")}</th>
              <th className="py-2 pr-4">{t("colReporter")}</th>
              <th className="py-2 pr-4">{t("colFiled")}</th>
              {/* QA-479: the flag surfaced the problem but the fix sat a
                  scroll away in the RFQ table — the spam action belongs
                  on the flag row itself (live RFQs only; a flag on a
                  terminal row needs no action). */}
              <th className="py-2">{t("colAction")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rfqFlagRows.map((r) => {
              const rfq = rfqFlagRfqs.get(r.rfqId);
              return (
                <Fragment key={r.id}>
                <tr data-testid={`rfq-report-${r.id}`}>
                  <td className="py-2 pr-4 font-medium">
                    {rfq?.buyerEmail ?? "—"}
                  </td>
                  <td className="py-2 pr-4">
                    {(rfq?.listingId
                      ? rfqFlagListings.get(rfq.listingId)
                      : undefined) ?? "—"}
                  </td>
                  <td className="py-2 pr-4" data-testid={`rfq-report-status-${r.id}`}>
                    {rfq?.status ?? "—"}
                  </td>
                  <td className="py-2 pr-4">
                    <Badge variant="warning" data-testid={`rfq-report-reason-${r.id}`}>
                      {r.reason}
                    </Badge>
                  </td>
                  <td className="max-w-60 truncate py-2 pr-4">{r.note ?? ""}</td>
                  <td className="py-2 pr-4">
                    {rfqFlagEmails.get(r.reporterId) ?? "—"}
                  </td>
                  <td className="py-2 pr-4">
                    {new Date(r.createdAt).toLocaleDateString(locale)}
                  </td>
                  <td className="py-2">
                    {/* QA-539: dismiss is always offered — a bogus flag
                        clears without punishing a legit RFQ. */}
                    <span className="inline-flex gap-1">
                      {rfq && LIVE_RFQ.has(rfq.status) ? (
                        <>
                          <RfqSpamButton rfqId={rfq.id} />
                          <RfqCloseButton rfqId={rfq.id} />
                        </>
                      ) : null}
                      <DismissRfqReportButton reportId={r.id} />
                    </span>
                  </td>
                </tr>
                {/* QA-538: the flag says WHY someone objected — the detail
                    row shows WHAT they objected to: the request's live
                    field map plus its amendment rungs (each carries the
                    superseded map), so a post-flag edit is visible too. */}
                <tr data-testid={`rfq-report-detail-${r.id}`}>
                  <td colSpan={8} className="pb-3 pt-0">
                    {rfq ? (
                      <div
                        className="max-w-2xl truncate text-xs text-muted"
                        data-testid={`rfq-report-fields-${r.id}`}
                      >
                        {Object.entries(rfq.fields)
                          .map(
                            ([k, v]) =>
                              `${fieldLabels.get(k) ?? k}: ${String(v ?? "")}`,
                          )
                          .join(" · ")}
                      </div>
                    ) : null}
                    {(() => {
                      const lines = rfq
                        ? amendmentDiffs(
                            rfqFlagAmends.get(rfq.id) ?? [],
                            rfq.fields,
                          )
                        : [];
                      if (!lines.length) return null;
                      return (
                        <ul
                          className="mt-1 space-y-0.5 text-xs text-muted"
                          data-testid={`rfq-report-amends-${r.id}`}
                        >
                          {lines.map(({ amendment: a, changes }) => (
                            <li key={a.id} data-testid={`rfqamend-${a.id}`}>
                              {t("amendLine", {
                                date: new Date(
                                  a.amendedAt,
                                ).toLocaleDateString(locale, {
                                  month: "short",
                                  day: "numeric",
                                }),
                                changes: changes
                                  .map(
                                    (c) =>
                                      `${fieldLabels.get(c.key) ?? c.key}: ${c.old} → ${c.next}`,
                                  )
                                  .join(" · "),
                              })}
                            </li>
                          ))}
                        </ul>
                      );
                    })()}
                  </td>
                </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table></div>
        )}
      </section>

      {/* QA-466: the blocked-address registry — the toggle on RFQ rows
          flips state, but without a list an admin can't audit (or undo)
          a past block. Same BuyerBlockButton renders the Unblock arm. */}
      <section className="mt-10" data-testid="admin-blocked">
        <h2 className="text-lg font-semibold">
          {t("blocked", { count: blockedRows.length })}
        </h2>
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-2xl text-left text-sm">
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 pr-4">{t("colEmail")}</th>
              <th className="py-2 pr-4">{t("colReason")}</th>
              <th className="py-2 pr-4">{t("colBlocked")}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {blockedRows.map((b) => (
              <tr key={b.id} data-testid={`blocked-row-${b.email}`}>
                <td className="py-2 pr-4 font-medium">{b.email}</td>
                <td className="max-w-60 truncate py-2 pr-4">
                  {b.reason ?? "—"}
                </td>
                <td className="py-2 pr-4 text-muted">
                  {new Date(b.createdAt).toLocaleDateString(locale)}
                </td>
                <td className="py-2">
                  <BuyerBlockButton email={b.email} blocked />
                </td>
              </tr>
            ))}
            {blockedRows.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-6 text-center text-muted">
                  {t("noBlocked")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table></div>
      </section>

      {/* QA-467: moderation activity — append-only audit feed so every
          enforcement write above is visible (who, what, on which target).
          same newest-first shape as the queues it records. */}
      <section className="mt-10" data-testid="admin-activity">
        <h2 className="text-lg font-semibold">
          {t("activity", { count: modEvents.length })}
        </h2>
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-2xl text-left text-sm">
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 pr-4">{t("colWhen")}</th>
              <th className="py-2 pr-4">{t("colAdmin")}</th>
              <th className="py-2 pr-4">{t("colAction")}</th>
              <th className="py-2">{t("colTarget")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {modEvents.map((e) => (
              <tr key={e.id} data-testid={`mod-event-${e.event}`}>
                <td className="py-2 pr-4 text-muted">
                  {new Date(e.createdAt).toLocaleDateString(locale)}
                </td>
                <td className="max-w-60 truncate py-2 pr-4">
                  {e.adminId ? (modEventEmails.get(e.adminId) ?? "—") : "—"}
                </td>
                <td className="py-2 pr-4">
                  <Badge variant="default">{e.event}</Badge>
                </td>
                <td className="py-2 text-muted">
                  {e.targetType}:{" "}
                  {e.targetType === "buyer_email"
                    ? e.targetId
                    : e.targetId.slice(0, 8)}
                </td>
              </tr>
            ))}
            {modEvents.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-6 text-center text-muted">
                  {t("noActivity")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table></div>
      </section>

      {/* QA-562: demand radar — supply-side intelligence. Buyers file
          search alerts for things that aren't listed; the grouped
          signature is the gap report (a digest backlog means matching
          supply arrived but hasn't mailed yet). */}
      <section className="mt-10" data-testid="admin-demand">
        <h2 className="text-lg font-semibold">
          {t("demandRadar", { count: searchAlerts.length })}
        </h2>
        <p className="mt-1 text-sm text-muted">{t("demandHint")}</p>
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-2xl text-left text-sm">
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 pr-4">{t("colDemand")}</th>
              <th className="py-2 pr-4">{t("colDemandBuyers")}</th>
              <th className="py-2 pr-4">{t("colDemandBacklog")}</th>
              <th className="py-2">{t("colDemandNewest")}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {demandGroups.map((g) => (
              <tr key={g.signature || "any"} data-testid="demand-row">
                <td className="max-w-96 truncate py-2 pr-4" data-testid="demand-sig">
                  {g.signature || t("demandAny")}
                </td>
                <td className="py-2 pr-4" data-testid="demand-buyers">
                  {g.buyers}
                </td>
                <td className="py-2 pr-4" data-testid="demand-backlog">
                  {g.backlog > 0 ? (
                    <Badge variant="warning">{g.backlog}</Badge>
                  ) : (
                    "0"
                  )}
                </td>
                <td className="py-2 text-muted">
                  {new Date(g.newest).toLocaleDateString(locale)}
                </td>
                <td className="py-2">
                  {g.backlog > 0 ? (
                    <DemandFlushButton signature={g.signature} />
                  ) : null}
                </td>
              </tr>
            ))}
            {demandGroups.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-6 text-center text-muted">
                  {t("noDemand")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table></div>
      </section>
    </main>
  );
}
