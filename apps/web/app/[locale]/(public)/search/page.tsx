import { EmptyState, Grid } from "@jetmarket/ui";
import { getTranslations } from "next-intl/server";
import { FacetSidebar } from "@/components/facet-sidebar";
import { ListingCard } from "@/components/listing-card";
import { getRepo } from "@/lib/repo";
import { searchListings } from "@/lib/search";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const t = await getTranslations("search");
  const repo = getRepo();
  const listings = searchListings(params);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
        <FacetSidebar params={params} />
        <section>
          <p className="mb-3 text-sm text-muted" data-testid="search-results-count">
            {t("results", { count: listings.length })}
          </p>
          {listings.length === 0 ? (
            <EmptyState title={t("emptyTitle")} body={t("emptyBody")} />
          ) : (
            <Grid cols={2} data-testid="search-results">
              {listings.map((l) => (
                <div key={l.id} data-testid="search-result">
                  <ListingCard
                    listing={l}
                    operator={repo.getOperator(l.operatorId) ?? null}
                  />
                </div>
              ))}
            </Grid>
          )}
        </section>
      </div>
    </main>
  );
}
