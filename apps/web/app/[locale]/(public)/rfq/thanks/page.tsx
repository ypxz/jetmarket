import { Card, CardBody } from "@jetmarket/ui";
import { getTranslations } from "next-intl/server";
import { CONCIERGE_PRICE_USD } from "@jetmarket/config";
import { ConciergeCard } from "./concierge-card";
import { ThanksQuotesLink } from "./quotes-link";

export default async function RfqThanksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const t = await getTranslations("rfq");
  const pick = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v) ?? "";
  const id = pick(sp.id);
  const email = pick(sp.email);

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-16 sm:px-6">
      <Card data-testid="rfq-confirmation">
        <CardBody>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("thanksTitle")}
          </h1>
          <p className="mt-2 text-sm text-muted">{t("thanksBody")}</p>
          {id ? (
            <p className="mt-3 text-sm font-medium" data-testid="rfq-reference">
              {t("thanksRef", { id })}
            </p>
          ) : null}
          <ThanksQuotesLink email={email} label={t("viewQuotes")} />
        </CardBody>
      </Card>
      {id && email ? (
        <ConciergeCard
          rfqId={id}
          email={email}
          labels={{
            title: t("concierge.title"),
            body: t("concierge.body"),
            cta: t("concierge.cta", { price: `$${CONCIERGE_PRICE_USD}` }),
            busy: t("concierge.ctaBusy"),
            done: t("concierge.done"),
            error: t("concierge.error"),
          }}
        />
      ) : null}
    </main>
  );
}
