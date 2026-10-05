import { Badge } from "@jetmarket/ui";
import { getVertical } from "@jetmarket/verticals";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { currentUser } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { getRepo } from "@/lib/repo";
import { invoiceStateVariant } from "@/lib/state-variant";
import { PrintButton } from "./print-button";

/**
 * QA-561: the operator's own copy of the success-fee invoice. The provider's
 * hosted URL (deal.invoiceUrl) settles the balance but isn't a durable
 * record — mock links are placeholders and real ones expire with the
 * provider account. This page renders the document from ledger data so the
 * operator can always print/save what they were charged for.
 */
export default async function DealInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const locale = await getLocale();
  const t = await getTranslations("app.invoice");
  const tc = await getTranslations("common");
  const td = await getTranslations("app.dashboard");
  const vertical = getVertical();
  const vt = await getTranslations(vertical.copy.namespace);
  const user = await currentUser();
  const repo = await getRepo();
  const operator = user ? await repo.getOperatorByUserId(user.id) : undefined;
  // listDeals(ids) resolves the joined row — buyerEmail + listingTitle come
  // from quote→rfq→listing, which the bare getDeal doesn't join.
  const [deal] = operator ? await repo.listDeals({ ids: [id] }) : [];
  // 404 for strangers and other operators' deals alike — no probing.
  if (!operator || !deal || deal.operatorId !== operator.id) notFound();

  const feePctLabel = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(deal.feePct);
  const invoiceNo = deal.invoiceRef ?? deal.id.slice(0, 8).toUpperCase();

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <p className="text-sm">
        <Link href="/app" className="text-primary underline">
          {t("backToDashboard")}
        </Link>
      </p>
      <article
        className="mt-4 rounded-lg border border-border p-6"
        data-testid="invoice"
      >
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <h1 className="text-xl font-semibold">
              {vt("home.eyebrow")} — {t("title")}
            </h1>
            <p className="mt-1 text-sm text-muted" data-testid="invoice-no">
              {t("invoiceNo", { ref: invoiceNo })} ·{" "}
              {t("issuedOn", { date: new Date(deal.closedAt).toDateString() })}
            </p>
          </div>
          <Badge variant={invoiceStateVariant(deal.invoiceStatus)}>
            {tc(`invoiceState.${deal.invoiceStatus}`)}
          </Badge>
        </header>

        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <dt className="text-muted">{t("billedTo")}</dt>
          <dd data-testid="invoice-billto">
            {operator.name}
            {user?.email ? ` · ${user.email}` : ""}
          </dd>
          <dt className="text-muted">{t("reference")}</dt>
          <dd className="text-muted" data-testid="invoice-dealref">
            {t("dealRef", { id: deal.id.slice(0, 8) })}
            {deal.buyerEmail ? ` · ${deal.buyerEmail}` : ""}
          </dd>
        </dl>

        <table className="mt-6 w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted">
              <th className="py-2 font-medium">{t("itemCol")}</th>
              <th className="py-2 text-right font-medium">{t("amountCol")}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <td className="py-3" data-testid="invoice-line">
                {t("feeLine", {
                  title: deal.listingTitle ?? td("openOfferFallback"),
                })}
                <span className="block text-xs text-muted">
                  {t("feeBase", {
                    amount: formatMoney(deal.amount, deal.currency, locale),
                    pct: feePctLabel,
                  })}
                </span>
              </td>
              <td className="py-3 text-right font-medium">
                {formatMoney(deal.feeAmount, deal.currency, locale)}
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td className="py-3 text-right font-semibold">{t("totalDue")}</td>
              <td
                className="py-3 text-right font-semibold"
                data-testid="invoice-total"
              >
                {formatMoney(deal.feeAmount, deal.currency, locale)}
              </td>
            </tr>
          </tfoot>
        </table>

        {deal.invoiceStatus === "void" ? (
          <p className="mt-4 text-sm text-muted" data-testid="invoice-void-note">
            {t("voidNote")}
          </p>
        ) : null}
      </article>

      <div className="mt-6">
        <PrintButton label={t("print")} />
      </div>
    </main>
  );
}
