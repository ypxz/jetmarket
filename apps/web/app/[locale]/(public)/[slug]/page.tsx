import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge, Container, EmptyState, Grid, Page, buttonVariants } from "@jetmarket/ui";
import { getVertical } from "@jetmarket/verticals";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { getRepo } from "@/lib/repo";
import { searchListings } from "@/lib/search";
import { resolveSeoPage, searchHref, seoSlugs } from "@/lib/seo";
import { ListingCard } from "@/components/listing-card";

// SEO landing pages are generated from vertical.seo.landingPages — any other
// slug under the (public) group is a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return routing.locales.flatMap((locale) =>
    seoSlugs().map((slug) => ({ locale, slug })),
  );
}

type Params = Promise<{ locale: string; slug: string }>;

async function resolve(params: Params) {
  const { slug } = await params;
  const vertical = getVertical();
  const def = resolveSeoPage(vertical, slug);
  return { vertical, def, slug };
}

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { locale } = await params;
  const { vertical, def, slug } = await resolve(params);
  if (!def) return {};
  const vt = await getTranslations({
    locale,
    namespace: `${vertical.copy.namespace}.seo.pages`,
  });
  return {
    title: vt(`${slug}.title`),
    description: def.introKey ? vt(`${slug}.intro`) : undefined,
    alternates: { canonical: `/${slug}` },
  };
}

export default async function SeoLandingPage({ params }: { params: Params }) {
  const { locale } = await params;
  const { vertical, def, slug } = await resolve(params);
  if (!def) notFound();

  const vt = await getTranslations({
    locale,
    namespace: `${vertical.copy.namespace}.seo.pages`,
  });
  const t = await getTranslations({ locale, namespace: "seo" });
  const ct = await getTranslations({ locale, namespace: "common" });

  const listings = searchListings(def.filters);
  const repo = getRepo();

  return (
    <Page data-testid="seo-page">
      <Container>
        <Badge>{vt("listingTypes." + String(def.filters.type ?? ""))}</Badge>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">
          {vt(`${slug}.title`)}
        </h1>
        <p className="mt-3 max-w-2xl text-muted">
          {def.introKey ? vt(`${slug}.intro`) : t("genericIntro")}
        </p>
        <p className="mt-2 text-xs text-muted">{ct("marketplaceNotice")}</p>

        <h2 className="sr-only">{t("listingsHeading")}</h2>
        {listings.length === 0 ? (
          <div className="mt-10" data-testid="seo-empty">
            <EmptyState title={t("emptyTitle")} body={t("emptyBody")} />
          </div>
        ) : (
          <>
            <p className="mt-10 text-sm text-muted" data-testid="seo-result-count">
              {t("results", { count: listings.length })}
            </p>
            <Grid className="mt-4" data-testid="seo-results">
              {listings.map((l) => (
                <ListingCard
                  key={l.id}
                  listing={l}
                  operator={repo.getOperator(l.operatorId)}
                />
              ))}
            </Grid>
          </>
        )}

        <div className="mt-10">
          <Link href={searchHref(def)} className={buttonVariants()}>
            {t("browseAll")}
          </Link>
        </div>
      </Container>
    </Page>
  );
}
