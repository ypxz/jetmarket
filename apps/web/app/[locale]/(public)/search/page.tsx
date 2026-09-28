import type { Metadata } from "next";
import { EmptyState, Grid } from "@jetmarket/ui";
import { getTranslations } from "next-intl/server";
import { FacetSidebar } from "@/components/facet-sidebar";
import { ListingCard } from "@/components/listing-card";
import { Pager } from "@/components/pager";
import { getRepo } from "@/lib/repo";
import { publicOperator } from "@/lib/repo/types";
import { searchListingsPage } from "@/lib/search";

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

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <div className="mt-6 flex flex-col gap-6 lg:flex-row">
        <FacetSidebar params={params} />
        <section className="min-w-0 flex-1">
          <p className="mb-3 text-sm text-muted" data-testid="search-results-count">
            {t("results", { count: total })}
          </p>
          {listings.length === 0 ? (
            <EmptyState title={t("emptyTitle")} body={t("emptyBody")} />
          ) : (
            <>
              <Grid cols={2} data-testid="search-results">
                {listings.map((l) => (
                  <div key={l.id} data-testid="search-result">
                    <ListingCard
                      listing={l}
                      operator={ops.get(l.operatorId) ?? null}
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
