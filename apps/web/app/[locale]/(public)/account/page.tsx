import { Badge } from "@jetmarket/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { currentUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { rfqDeadlineAt } from "@/lib/rfq-deadline";
import { verticalSlug } from "@/lib/vertical";

/** QA-468: buyer account surface. Buyers hold real sessions (report filing
 *  requires one) but had nothing under their name — /quotes is a
 *  token-based inbox, this is the session-based home: their requests and
 *  the status of the reports they filed. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const LIVE = new Set(["open", "matched", "quoted"]);

export default async function AccountPage() {
  const [t, tc] = await Promise.all([
    getTranslations("account"),
    getTranslations("common"),
  ]);
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const repo = await getRepo();
  const [myRfqs, myReports, operator] = await Promise.all([
    repo.listRfqs({
      buyerEmail: user.email,
      vertical: verticalSlug(),
      limit: 20,
    }),
    repo.listListingReports({ reporterId: user.id, limit: 50 }),
    repo.getOperatorByUserId(user.id),
  ]);
  const reportListingRows = await repo.listListings({
    ids: [...new Set(myReports.map((r) => r.listingId))],
  });
  const reportListings = new Map(reportListingRows.map((l) => [l.id, l]));

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold" data-testid="account-title">
        {t("title")}
      </h1>
      <p className="mt-1 text-sm text-muted" data-testid="account-email">
        {user.email}
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">{t("operatorTitle")}</h2>
        {operator ? (
          <Link
            href="/app"
            className="mt-3 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            data-testid="account-open-app"
          >
            {t("openDashboard")}
          </Link>
        ) : (
          <Link
            href="/app/onboarding"
            className="mt-3 inline-block rounded-md border border-border px-4 py-2 text-sm"
            data-testid="account-onboard-cta"
          >
            {t("becomeOperator")}
          </Link>
        )}
      </section>

      <section className="mt-10" data-testid="account-requests">
        <h2 className="text-lg font-semibold">
          {t("requests", { count: myRfqs.length })}
        </h2>
        <p className="mt-1 text-sm text-muted">
          <Link href="/quotes" className="underline" data-testid="account-quotes-link">
            {t("viewInbox")}
          </Link>
        </p>
        <ul className="mt-4 divide-y divide-border">
          {myRfqs.map((r) => (
            <li key={r.id} className="py-3" data-testid={`account-rfq-${r.id}`}>
              <span className="flex items-center justify-between gap-4">
                <span className="text-sm text-muted">
                  {new Date(r.createdAt).toLocaleDateString("en-US")}
                </span>
                <span className="flex items-center gap-2">
                  <Badge variant="outline">{tc(`rfqState.${r.status}`)}</Badge>
                  {LIVE.has(r.status) ? (
                    <span className="text-xs text-muted">
                      {t("closesOn", {
                        date: rfqDeadlineAt(r).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        }),
                      })}
                    </span>
                  ) : null}
                </span>
              </span>
            </li>
          ))}
          {myRfqs.length === 0 ? (
            <li className="py-6 text-sm text-muted" data-testid="account-rfqs-empty">
              {t("noRequests")}
            </li>
          ) : null}
        </ul>
      </section>

      <section className="mt-10" data-testid="account-reports">
        <h2 className="text-lg font-semibold">
          {t("reports", { count: myReports.length })}
        </h2>
        <ul className="mt-4 divide-y divide-border">
          {myReports.map((r) => (
            <li key={r.id} className="py-3" data-testid={`account-report-${r.id}`}>
              <span className="flex items-center justify-between gap-4">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {reportListings.get(r.listingId)?.title ?? "—"}
                  </span>
                  <span className="text-xs text-muted">
                    {t(`reason.${r.reason}` as Parameters<typeof t>[0])} ·{" "}
                    {new Date(r.createdAt).toLocaleDateString("en-US")}
                  </span>
                </span>
                <Badge
                  variant={r.status === "open" ? "warning" : "default"}
                  data-testid={`account-report-status-${r.id}`}
                >
                  {t(`reportStatus.${r.status}` as Parameters<typeof t>[0])}
                </Badge>
              </span>
            </li>
          ))}
          {myReports.length === 0 ? (
            <li className="py-6 text-sm text-muted" data-testid="account-reports-empty">
              {t("noReports")}
            </li>
          ) : null}
        </ul>
      </section>
    </main>
  );
}
