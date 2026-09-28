import { Badge, Card, CardBody, EmptyState, Grid, Stack } from "@jetmarket/ui";
import { site } from "@jetmarket/config";
import { cache } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { ListingCard } from "@/components/listing-card";
import { Link } from "@/i18n/navigation";
import { getRepo } from "@/lib/repo";
import { publicOperator } from "@/lib/repo/types";
import { browseExpiry } from "@/lib/search";
import { siteUrl } from "@/lib/seo";
import { verticalConfig, verticalSlug } from "@/lib/vertical";

// Escape </script> breakouts inside JSON-LD payloads.
const jsonLd = (data: object) =>
  JSON.stringify(data).replace(/</g, "\\u003c");

const PAGE_SIZE = 48;

// generateMetadata and the page render share the fetch — cache() dedupes
// per request (QA-242).
const load = cache(async (id: string) => {
  const repo = await getRepo();
  const operator = await repo.getOperator(id);
  if (!operator) return null;
  const listings = await repo.listListings({
    operatorId: operator.id,
    vertical: verticalSlug(),
    status: "active",
    limit: PAGE_SIZE,
    ...browseExpiry(),
  });
  return { operator, listings };
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const found = await load(id);
  if (!found) return {};
  const t = await getTranslations("operator");
  return {
    title: `${found.operator.name} — ${site.name}`,
    description: t("metaDescription", {
      name: found.operator.name,
      count: found.listings.length,
      siteName: site.name,
    }),
    twitter: {
      card: "summary_large_image",
      title: found.operator.name,
      description: t("metaDescription", {
        name: found.operator.name,
        count: found.listings.length,
        siteName: site.name,
      }),
    },
  };
}

export default async function OperatorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("operator");
  const ct = await getTranslations("common");
  const vt = await getTranslations(`${verticalConfig().copy.namespace}.operator`);
  const found = await load(id);
  if (!found) notFound();
  const { operator, listings } = found;
  const pub = publicOperator(operator);

  const orgLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: pub.name,
    url: `${siteUrl()}/operators/${operator.id}`,
    ...(pub.baseAirport
      ? { address: { "@type": "PostalAddress", addressLocality: pub.baseAirport } }
      : {}),
  };

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(orgLd) }}
      />
      <Link href="/search" className="text-sm text-muted hover:text-foreground">
        {ct("backToSearch")}
      </Link>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight" data-testid="operator-name">
          {pub.name}
        </h1>
        {pub.verified ? (
          <Badge variant="success">{ct("verified")}</Badge>
        ) : (
          <Badge variant="warning">{ct("unverified")}</Badge>
        )}
      </div>

      <Card className="mt-6">
        <CardBody>
          <Stack gap="sm">
            <p className="text-sm text-muted" data-testid="operator-base">
              {vt("basedAt", { place: pub.baseAirport || "—" })}
            </p>
            {pub.fleetSummary ? (
              <p className="text-sm" data-testid="operator-fleet">
                {pub.fleetSummary}
              </p>
            ) : null}
            <p className="text-xs text-muted">{ct("marketplaceNotice")}</p>
          </Stack>
        </CardBody>
      </Card>

      <h2 className="mt-10 text-xl font-semibold" data-testid="operator-listings-title">
        {t("listingsTitle", { count: listings.length })}
      </h2>
      {listings.length === 0 ? (
        <EmptyState title={t("emptyTitle")} body={t("emptyBody")} />
      ) : (
        <Grid cols={2} data-testid="operator-listings">
          {listings.map((l) => (
            <ListingCard key={l.id} listing={l} operator={pub} />
          ))}
        </Grid>
      )}
    </main>
  );
}
