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
  const repo = await getRepo();
  const listings = await searchListings(params);
  const ops = new Map(
    await Promise.all(
      [...new Set(listings.map((l) => l.operatorId))].map(
        async (id) => [id, (await repo.getOperator(id)) ?? null] as const,
      ),
    ),
  );

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <div className="mt-6 flex flex-col gap-6 lg:flex-row">
        <FacetSidebar params={params} />
        <section className="min-w-0 flex-1">
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
                    operator={ops.get(l.operatorId) ?? null}
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
