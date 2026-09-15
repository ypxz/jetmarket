import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { getRepo } from "@/lib/repo";
import { VerifyButton } from "./verify-button";

export default async function AdminPage() {
  const t = await getTranslations("admin");
  const user = await currentUser();
  if (!user || user.role !== "admin") redirect("/sign-in");

  const repo = await getRepo();
  const operators = await repo.listOperators();
  const deals = await repo.listDeals();
  const listingCounts = new Map(
    await Promise.all(
      operators.map(async (o) => [o.id, await repo.countOperatorListings(o.id)] as const),
    ),
  );
  const dealOps = new Map(
    await Promise.all(
      deals.map(async (d) => [d.id, (await repo.getOperator(d.operatorId))?.name ?? "?"] as const),
    ),
  );
  const feeTotal = deals.reduce((s, d) => s + d.feeAmount, 0);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">
          {t("operators", { count: operators.length })}
        </h2>
        <div className="overflow-x-auto"><table className="mt-3 w-full w-max min-w-full text-left text-sm">
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
            count: deals.length,
            total: formatMoney(feeTotal, "USD"),
          })}
        </h2>
        <div className="overflow-x-auto"><table className="mt-3 w-full w-max min-w-full text-left text-sm" data-testid="fee-ledger">
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
                <td className="py-2 pr-4">{formatMoney(d.amount, "USD")}</td>
                <td className="py-2 pr-4">{(d.feePct * 100).toFixed(1)}%</td>
                <td className="py-2 pr-4 font-medium">{formatMoney(d.feeAmount, "USD")}</td>
                <td className="py-2 pr-4" data-testid={`deal-invoice-${d.id}`}>
                  {d.invoiceStatus}
                  {d.invoiceRef ? (
                    <span className="ml-1 font-mono text-xs text-muted">
                      {d.invoiceRef}
                    </span>
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
      </section>
    </main>
  );
}
