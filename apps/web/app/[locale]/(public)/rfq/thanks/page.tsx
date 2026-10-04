import { Card, CardBody } from "@jetmarket/ui";
import { getTranslations } from "next-intl/server";
import { CONCIERGE_PRICE_USD } from "@jetmarket/config";
import { getRepo } from "@/lib/repo";
import { isExpiredListing } from "@/lib/search";
import { verticalSlug } from "@/lib/vertical";
import { SearchAlertForm } from "@/components/search-alert-form";
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

  // QA-411 watch CTA: the RFQ just expressed intent on one listing — offer
  // "watch it" on the same pipeline while the buyer is warm. Hidden when the
  // listing is gone/foreign/expired (a watch on it could never fire).
  const repo = await getRepo();
  const rfq = id ? await repo.getRfq(id).catch(() => null) : null;
  const listing =
    rfq && rfq.vertical === verticalSlug()
      ? await repo.getListing(rfq.listingId).catch(() => null)
      : null;
  const watchable =
    listing && listing.status === "active" && !isExpiredListing(listing);
  const tl = await getTranslations("listing");

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
      {watchable ? (
        <div className="mt-4" data-testid="thanks-watch">
          <SearchAlertForm
            params={{ watch: listing.id }}
            title={tl("watchTitle")}
            emailPlaceholder={tl("watchEmail")}
            emailDefault={email || undefined}
            submitLabel={tl("watchSubmit")}
            sendingLabel={tl("watchSending")}
            sentLabel={tl("watchSent")}
            errorLabel={tl("watchError")}
            freqInstantLabel={tl("watchFreqInstant")}
            freqDailyLabel={tl("watchFreqDaily")}
          />
        </div>
      ) : null}
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
