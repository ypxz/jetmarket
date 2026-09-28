import { Badge } from "@jetmarket/ui";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Pager } from "@/components/pager";
import { currentUser } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { Link } from "@/i18n/navigation";
import { getRepo } from "@/lib/repo";
import { SEARCH_PAGE_SIZE } from "@/lib/search";
import { invoiceStateVariant } from "@/lib/state-variant";
import { verticalConfig } from "@/lib/vertical";
import { ListingModButton } from "./listing-mod-button";
import { MarkPaidButton, VoidInvoiceButton } from "./mark-paid";
import { VerifyButton } from "./verify-button";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const t = await getTranslations("admin");
  const tc = await getTranslations("common");
  const user = await currentUser();
  if (!user || user.role !== "admin") redirect("/sign-in");

  const repo = await getRepo();
  const operatorCount = await repo.countOperators();
  const dealTotal = await repo.countDeals();
  const dealPages = Math.max(1, Math.ceil(dealTotal / SEARCH_PAGE_SIZE));
  const rawPage = Number(Array.isArray(params.page) ? params.page[0] : params.page);
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? Math.min(rawPage, dealPages) : 1;
  const deals = await repo.listDeals({
    limit: SEARCH_PAGE_SIZE,
    offset: (page - 1) * SEARCH_PAGE_SIZE,
  });
  // Cap the table render — count in the header already reflects the true total;
  // beyond 100 operators this page needs a pager, not a longer table.
  const operators = await repo.listOperators({ limit: 100 });
  // One grouped query + one Map build — was 100 sequential counts (QA-100).
  const listingCounts = new Map(
    Object.entries(await repo.listListingCountsByOperator(operators.map((o) => o.id))),
  );
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
  const feeTotal = await repo.sumDealFees();

  // Listing moderation (QA-157): newest 50 across live states — the takedown
  // targets are active/paused listings, not drafts or already-archived rows.
  const modListings = await repo.listListings({ limit: 50 });
  const modOpRows = await repo.listOperators({
    ids: [...new Set(modListings.map((l) => l.operatorId))],
  });
  const modOpNames = new Map(modOpRows.map((o) => [o.id, o.name] as const));

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm">
        <Link href="/admin/jobs" className="text-muted underline">
          {t("viewJobs")}
        </Link>
      </p>

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
                <td className="py-2 pr-4 font-medium">{o.name}</td>
                <td className="py-2 pr-4">{o.baseAirport}</td>
                <td className="py-2 pr-4">{o.plan}</td>
                <td className="py-2 pr-4">{listingCounts.get(o.id) ?? 0}</td>
                <td className="py-2 pr-4" data-testid={`admin-verified-${o.id}`}>
                  {o.verified ? t("yes") : t("no")}
                </td>
                <td className="py-2">
                  <VerifyButton operatorId={o.id} verified={o.verified} />
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
            total: formatMoney(feeTotal, siteCurrency),
          })}
        </h2>
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-2xl text-left text-sm" data-testid="fee-ledger">
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 pr-4">{t("colDeal")}</th>
              <th className="py-2 pr-4">{t("colOperator")}</th>
              <th className="py-2 pr-4">{t("colAmount")}</th>
              <th className="py-2 pr-4">{t("colFeePct")}</th>
              <th className="py-2 pr-4">{t("colFee")}</th>
              <th className="py-2 pr-4">{t("colInvoice")}</th>
              <th className="py-2">{t("colClosed")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {deals.map((d) => (
              <tr key={d.id} data-testid={`deal-${d.id}`}>
                <td className="py-2 pr-4 font-mono text-xs">{d.id}</td>
                <td className="py-2 pr-4">{dealOps.get(d.id)}</td>
                <td className="py-2 pr-4">{formatMoney(d.amount, d.currency)}</td>
                <td className="py-2 pr-4">{(d.feePct * 100).toFixed(1)}%</td>
                <td className="py-2 pr-4 font-medium">{formatMoney(d.feeAmount, d.currency)}</td>
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
                </td>
                <td className="py-2 text-muted">{new Date(d.closedAt).toLocaleDateString("en-US")}</td>
              </tr>
            ))}
            {deals.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-6 text-center text-muted">
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
    </main>
  );
}
