import type { Metadata } from "next";
import { EmptyState, Grid } from "@jetmarket/ui";
import { getTranslations } from "next-intl/server";
import { FacetSidebar } from "@/components/facet-sidebar";
import { ListingCard } from "@/components/listing-card";
import { Pager } from "@/components/pager";
import { SearchAlertForm } from "@/components/search-alert-form";
import { getRepo } from "@/lib/repo";
import { publicOperator } from "@/lib/repo/types";
import { browseExpiry, searchListingsPage } from "@/lib/search";
import { verticalSlug } from "@/lib/vertical";

// Parameterized results are disallowed in robots.txt; noindex keeps the
// crawl surface to the curated SEO landing slugs + listing pages.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const t = await getTranslations("search");
  // Cards carry the query string so "← Back to search" on a listing restores
  // the buyer's filters (QA-217). `page` excluded — back lands on page 1 of
  // the same filter set, not mid-pager.
  const fromQuery = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) =>
      (Array.isArray(v) ? v : [v])
        .filter((x): x is string => typeof x === "string" && x !== "" && k !== "page")
        .map((x) => [k, x] as [string, string]),
    ),
  ).toString();
  const repo = await getRepo();
  const { items: listings, page, pages, total } =
    await searchListingsPage(params);
  const ops = new Map(
    (
      await repo.listOperators({
        ids: [...new Set(listings.map((l) => l.operatorId))],
      })
    ).map((o) => [o.id, publicOperator(o)] as const),
  );
  // QA-453: ★ rides the comparison grid — one batched read for every op
  // the page renders (results rail only; the QA-432 empty-rail stays
  // rating-free — those are "latest" discovery cards, not comparisons).
  const ratings = await repo.ratingSummaryPerOperator([...ops.keys()]);

  // QA-432: a zero-result page used to dead-end — surface the newest live
  // listings under the empty state so a too-tight filter still lands
  // somewhere browsable (same active+unexpired predicate browse uses).
  const latest =
    listings.length === 0
      ? await repo.listListings({
          vertical: verticalSlug(),
          status: "active",
          limit: 4,
          ...browseExpiry(),
        })
      : [];
  const latestOps = new Map(
    (
      await repo.listOperators({
        ids: [...new Set(latest.map((l) => l.operatorId))],
      })
    ).map((o) => [o.id, publicOperator(o)] as const),
  );

  // Confirm/unsubscribe land back on /search with ?alert=<state> — it is
  // page furniture, not part of the saved filter set (QA-403).
  const alertState = params["alert"];
  const savedParams = Object.fromEntries(
    Object.entries(params).filter(([k]) => k !== "alert"),
  );

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      {alertState === "confirmed" ? (
        <p className="mt-3 rounded-md border border-border bg-surface px-3 py-2 text-sm" data-testid="search-alert-confirmed">
          {t("alertConfirmed")}
        </p>
      ) : null}
      {alertState === "unsubscribed" ? (
        <p className="mt-3 rounded-md border border-border bg-surface px-3 py-2 text-sm" data-testid="search-alert-off">
          {t("alertUnsubscribed")}
        </p>
      ) : null}
      {alertState === "invalid" ? (
        <p className="mt-3 rounded-md border border-border bg-surface px-3 py-2 text-sm" data-testid="search-alert-invalid">
          {t("alertInvalid")}
        </p>
      ) : null}
      <div className="mt-6 flex flex-col gap-6 lg:flex-row">
        <FacetSidebar params={params} />
        <section className="min-w-0 flex-1">
          <p className="mb-3 text-sm text-muted" data-testid="search-results-count">
            {t("results", { count: total })}
          </p>
          <div className="mb-4">
            <SearchAlertForm
              params={savedParams}
              title={t("alertTitle")}
              emailPlaceholder={t("alertEmail")}
              submitLabel={t("alertSubmit")}
              sendingLabel={t("alertSending")}
              sentLabel={t("alertSent")}
              errorLabel={t("alertError")}
              freqInstantLabel={t("alertFreqInstant")}
              freqDailyLabel={t("alertFreqDaily")}
              matchedLabel={t("alertMatched")}
            />
          </div>
          {listings.length === 0 ? (
            <>
              <EmptyState title={t("emptyTitle")} body={t("emptyBody")} />
              {latest.length > 0 ? (
                <section className="mt-8" data-testid="search-latest">
                  <h2 className="mb-3 text-lg font-semibold">
                    {t("latestTitle")}
                  </h2>
                  <Grid cols={2}>
                    {latest.map((l) => (
                      <div key={l.id} data-testid="search-latest-item">
                        <ListingCard
                          listing={l}
                          operator={latestOps.get(l.operatorId) ?? null}
                        />
                      </div>
                    ))}
                  </Grid>
                </section>
              ) : null}
            </>
          ) : (
            <>
              <Grid cols={2} data-testid="search-results">
                {listings.map((l) => (
                  <div key={l.id} data-testid="search-result">
                    <ListingCard
                      listing={l}
                      operator={ops.get(l.operatorId) ?? null}
                      rating={ratings[l.operatorId]}
                      from={fromQuery || undefined}
                    />
                  </div>
                ))}
              </Grid>
              <Pager
                basePath="/search"
                params={params}
                page={page}
                pages={pages}
              />
            </>
          )}
        </section>
      </div>
    </main>
  );
}
