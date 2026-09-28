import { Badge, Card, CardBody, CardHeader, CardTitle, Stack, buttonVariants } from "@jetmarket/ui";
import { site } from "@jetmarket/config";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { AttributeTable } from "@/components/attribute-table";
import { Gallery } from "@/components/gallery";
import { ListingCard } from "@/components/listing-card";
import { Link } from "@/i18n/navigation";
import { formatMoney } from "@/lib/format";
import { getRepo } from "@/lib/repo";
import { publicOperator } from "@/lib/repo/types";
import { browseExpiry, isExpiredListing } from "@/lib/search";
import { siteUrl } from "@/lib/seo";

// Escape </script> breakouts inside JSON-LD payloads.
const jsonLd = (data: object) =>
  JSON.stringify(data).replace(/</g, "\\u003c");

async function load(id: string) {
  const repo = await getRepo();
  const listing = await repo.getListing(id);
  // Expired dated inventory is gone for buyers — 404 like a withdrawn one.
  return listing?.status === "active" && !isExpiredListing(listing)
    ? listing
    : null;
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
  // og:image comes from ./opengraph-image.tsx — a generated first-party card,
  // since listing photos may be external URLs we must not hotlink.
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
    twitter: {
      card: "summary_large_image",
      title: listing.title,
      description,
    },
  };
}

export default async function ListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  // Cards on /search carry the filter query so "back" restores it. searchParams
  // already decoded the value once — the string below is the raw query tail; it
  // only ever lands inside a /search URL, so a crafted `from` can't navigate
  // anywhere else.
  const fromRaw = sp.from;
  const from = (Array.isArray(fromRaw) ? fromRaw[0] : fromRaw)
    ?.replace(/^[/?#\s]+/, "");
  const backHref = from ? `/search?${from}` : "/search";
  const t = await getTranslations("listing");
  const ct = await getTranslations("common");
  const listing = await load(id);
  if (!listing) notFound();
  const repo = await getRepo();
  const operator = await repo.getOperator(listing.operatorId) ?? null;

  // Same-type siblings keep the buyer in the browse loop when this one
  // doesn't fit — 5 fetched so dropping self still yields up to 4.
  const similar = (
    await repo.listListings({
      vertical: listing.vertical,
      type: listing.type,
      status: "active",
      limit: 5,
      ...browseExpiry(),
    })
  )
    .filter((l) => l.id !== listing.id)
    .slice(0, 4);
  const similarOps = new Map(
    (
      await repo.listOperators({
        ids: [...new Set(similar.map((l) => l.operatorId))],
      })
    ).map((o) => [o.id, publicOperator(o)] as const),
  );

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
      <Link href={backHref} className="text-sm text-muted hover:text-foreground" data-testid="back-to-search">
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
              {operator ? (
                <Link
                  href={`/operators/${listing.operatorId}`}
                  className="font-medium hover:underline"
                  data-testid="listing-operator-link"
                >
                  {operator.name}
                </Link>
              ) : (
                <p className="font-medium">{t("operator")}</p>
              )}
              <p className="text-sm text-muted">
                {t("basedAt", { airport: operator?.baseAirport ?? "—" })} ·{" "}
                {operator?.fleetSummary}
              </p>
              <p className="text-xs text-muted">{ct("marketplaceNotice")}</p>
            </Stack>
          </CardBody>
        </Card>
      </div>

      {similar.length > 0 ? (
        <section className="mt-10" data-testid="similar-listings">
          <h2 className="text-xl font-semibold">{t("similar")}</h2>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {similar.map((l) => (
              <ListingCard
                key={l.id}
                listing={l}
                operator={similarOps.get(l.operatorId) ?? null}
              />
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
