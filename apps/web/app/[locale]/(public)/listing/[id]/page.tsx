import { Badge, Card, CardBody, CardHeader, CardTitle, Stack, buttonVariants } from "@jetmarket/ui";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { AttributeTable } from "@/components/attribute-table";
import { Gallery } from "@/components/gallery";
import { Link } from "@/i18n/navigation";
import { formatMoney } from "@/lib/format";
import { getRepo } from "@/lib/repo";

export default async function ListingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("listing");
  const ct = await getTranslations("common");
  const repo = getRepo();
  const listing = repo.getListing(id);
  if (!listing || listing.status !== "active") notFound();
  const operator = repo.getOperator(listing.operatorId) ?? null;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
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
