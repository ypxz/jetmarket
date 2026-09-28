import { getTranslations } from "next-intl/server";
import { currentUser } from "@/lib/auth";
import { Link } from "@/i18n/navigation";
import { FREE_LISTING_LIMIT, PRO_PLAN_PRICE_USD } from "@/lib/fees";
import { getRepo } from "@/lib/repo";
import { PortalButton } from "./portal-button";
import { UpgradeButton } from "./upgrade-button";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("app.billing");
  const tc = await getTranslations("checkout");
  const { checkout } = await searchParams;
  const user = await currentUser();
  const repo = await getRepo();
  const operator = user ? await repo.getOperatorByUserId(user.id) : undefined;
  const sub = operator ? await repo.getSubscription(operator.id) : undefined;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      {checkout === "success" ? (
        <p
          data-testid="checkout-success"
          className="mt-4 rounded-md border border-[color:var(--color-success)] bg-[color:var(--color-success)]/10 px-4 py-3 text-sm"
        >
          {tc("success")}
        </p>
      ) : checkout === "cancel" ? (
        <p
          data-testid="checkout-cancel"
          className="mt-4 rounded-md border border-border px-4 py-3 text-sm text-muted"
        >
          {tc("canceled")}
        </p>
      ) : null}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-border p-5">
          <h2 className="font-semibold">{t("free")}</h2>
          <p className="mt-1 text-sm text-muted">
            {t("freeLine", { limit: FREE_LISTING_LIMIT })}
          </p>
          <p className="mt-4 text-2xl font-semibold">$0</p>
        </div>
        <div className="rounded-md border-2 border-primary p-5">
          <h2 className="font-semibold">{t("pro")}</h2>
          <p className="mt-1 text-sm text-muted">{t("proLine")}</p>
          <p className="mt-4 text-2xl font-semibold">
            ${PRO_PLAN_PRICE_USD}<span className="text-sm font-normal text-muted">{t("perMonth")}</span>
          </p>
          {!operator ? (
            // Buyers can reach /app now (QA-267) — without an operator
            // profile checkout would just 401, so route them to onboarding.
            <Link
              href="/app/onboarding"
              className="mt-4 inline-block rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
            >
              {t("needProfile")}
            </Link>
          ) : operator.plan === "pro" ? (
            <>
              <p className="mt-3 text-sm font-medium text-[color:var(--color-success)]" data-testid="pro-active">
                {sub
                  ? t("activeUntil", {
                      date: new Date(sub.currentPeriodEnd).toDateString(),
                    })
                  : t("active")}
              </p>
              <PortalButton />
            </>
          ) : (
            <UpgradeButton />
          )}
        </div>
      </div>
      <p className="mt-6 text-xs text-muted">{t("feeNote")}</p>
    </main>
  );
}
