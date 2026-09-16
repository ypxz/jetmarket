import { Badge, Card, CardBody, CardHeader, CardTitle, Stack, buttonVariants } from "@jetmarket/ui";
import { site } from "@jetmarket/config";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { AttributeTable } from "@/components/attribute-table";
import { Gallery } from "@/components/gallery";
import { Link } from "@/i18n/navigation";
import { formatMoney } from "@/lib/format";
import { getRepo } from "@/lib/repo";
import { siteUrl } from "@/lib/seo";

// Escape </script> breakouts inside JSON-LD payloads.
const jsonLd = (data: object) =>
  JSON.stringify(data).replace(/</g, "\\u003c");

async function load(id: string) {
  const repo = await getRepo();
  const listing = await repo.getListing(id);
  return listing?.status === "active" ? listing : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const listing = await load(id);
  if (!listing) return {};
  const t = await getTranslations("listing");
  const description = t("metaDescription", {
    title: listing.title,
    price: formatMoney(listing.price, listing.currency),
    siteName: site.name,
  });
  // No og:image — photos may be external URLs; don't hotlink other hosts.
  return {
    title: listing.title,
    description,
    alternates: { canonical: `${siteUrl()}/listing/${listing.id}` },
    openGraph: {
      title: listing.title,
      description,
      url: `${siteUrl()}/listing/${listing.id}`,
      siteName: site.name,
      type: "website",
    },
    twitter: { card: "summary", title: listing.title, description },
  };
}

export default async function ListingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("listing");
  const ct = await getTranslations("common");
  const listing = await load(id);
  if (!listing) notFound();
  const repo = await getRepo();
  const operator = await repo.getOperator(listing.operatorId) ?? null;

  const productLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: listing.title,
    url: `${siteUrl()}/listing/${listing.id}`,
    brand: operator?.name
      ? { "@type": "Organization", name: operator.name }
      : undefined,
    offers: {
      "@type": "Offer",
      price: listing.price,
      priceCurrency: listing.currency,
      availability: "https://schema.org/InStock",
    },
  };

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(productLd) }}
      />
      <Link href="/search" className="text-sm text-muted hover:text-foreground">
        {t("back")}
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight" data-testid="listing-title">
            {listing.title}
          </h1>
          {operator ? (
            <p className="mt-2 text-sm text-muted">
              {t("operator")}: {operator.name} ·{" "}
              {t("basedAt", { airport: operator.baseAirport })}{" "}
              {operator.verified ? (
                <Badge variant="success">{ct("verified")}</Badge>
              ) : (
                <Badge variant="warning">{ct("unverified")}</Badge>
              )}
            </p>
          ) : null}
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold" data-testid="listing-price">
            {formatMoney(listing.price, listing.currency)}
          </p>
          <Link
            href={`/rfq/${listing.id}`}
            className={buttonVariants({ size: "lg" })}
            data-testid="listing-rfq-cta"
          >
            {t("rfqCta")}
          </Link>
        </div>
      </div>

      <div className="mt-8">
        <Gallery photos={listing.photos} title={listing.title} />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("attributes")}</CardTitle>
          </CardHeader>
          <CardBody>
            <AttributeTable listing={listing} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("operator")}</CardTitle>
          </CardHeader>
          <CardBody>
            <Stack gap="sm">
              <p className="font-medium">{operator?.name}</p>
              <p className="text-sm text-muted">
                {t("basedAt", { airport: operator?.baseAirport ?? "—" })} ·{" "}
                {operator?.fleetSummary}
              </p>
              <p className="text-xs text-muted">{ct("marketplaceNotice")}</p>
            </Stack>
          </CardBody>
        </Card>
      </div>
    </main>
  );
}
