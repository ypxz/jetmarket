import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { currentUser } from "@/lib/auth";
import { FREE_LISTING_LIMIT, PRO_PLAN_PRICE_USD } from "@/lib/fees";
import { formatMoney } from "@/lib/format";
import { getRepo } from "@/lib/repo";

export default async function OperatorDashboard() {
  const t = await getTranslations("app.dashboard");
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

  const listings = await repo.listListings({ operatorId: operator.id });
  const rfqs = await repo.listRfqs({ operatorId: operator.id });
  const sub = await repo.getSubscription(operator.id);
  const limit = operator.plan === "pro" ? "∞" : String(FREE_LISTING_LIMIT);

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
            {operator.plan === "pro" ? t("proPlan") : t("freePlan")}
          </div>
          {operator.plan === "free" ? (
            <Link href="/app/billing" className="text-primary underline">
              {t("upgrade", { price: PRO_PLAN_PRICE_USD })}
            </Link>
          ) : null}
        </div>
      </div>

      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {t("listings", { count: listings.length, limit })}
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
            {t("noListings")}
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-border rounded-md border border-border">
            {listings.map((l) => (
              <li key={l.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <div className="font-medium">{l.title}</div>
                  <div className="text-xs text-muted">
                    {l.type} · {l.status}
                  </div>
                </div>
                <div className="text-sm font-medium">
                  {formatMoney(l.price, l.currency)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">
          {t("rfqInbox", {
            count: rfqs.filter((r) => r.status !== "closed").length,
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
