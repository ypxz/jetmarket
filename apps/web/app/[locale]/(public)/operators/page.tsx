import { Badge, Card, CardBody, EmptyState, Grid, Stack } from "@jetmarket/ui";
import { site } from "@jetmarket/config";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getRepo } from "@/lib/repo";
import { publicOperator } from "@/lib/repo/types";
import { browseExpiry } from "@/lib/search";
import { siteUrl } from "@/lib/seo";
import { verticalConfig, verticalSlug } from "@/lib/vertical";

const jsonLd = (data: object) =>
  JSON.stringify(data).replace(/</g, "\\u003c");

const load = async () => {
  const repo = await getRepo();
  const rows = await repo.listOperatorDirectory({
    vertical: verticalSlug(),
    ...browseExpiry(),
  });
  // QA-455: ★ on directory cards — one batched read, same grouped shape as
  // the search grid (unrated cards hide rather than averaging to zero).
  const ratings = await repo.ratingSummaryPerOperator(
    rows.map((r) => r.operator.id),
  );
  return rows.map((r) => ({ ...r, rating: ratings[r.operator.id] }));
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("operator");
  return {
    title: `${t("indexTitle")} — ${site.name}`,
    description: t("indexMeta", { siteName: site.name }),
    alternates: { canonical: `${siteUrl()}/operators` },
    twitter: {
      card: "summary",
      title: t("indexTitle"),
      description: t("indexMeta", { siteName: site.name }),
    },
  };
}

export default async function OperatorsIndexPage() {
  const t = await getTranslations("operator");
  const ct = await getTranslations("common");
  const vt = await getTranslations(`${verticalConfig().copy.namespace}.operator`);
  const rows = await load();

  const listLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: rows.map((r, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${siteUrl()}/operators/${r.operator.id}`,
      name: r.operator.name,
    })),
  };

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(listLd) }}
      />
      <h1
        className="text-3xl font-semibold tracking-tight"
        data-testid="operators-index-title"
      >
        {t("indexTitle")}
      </h1>
      <p className="mt-2 text-sm text-muted">{ct("marketplaceNotice")}</p>

      {rows.length === 0 ? (
        <div className="mt-8">
          <EmptyState title={t("indexEmpty")} body={t("indexEmptyBody")} />
        </div>
      ) : (
        <Grid cols={2} className="mt-8" data-testid="operators-index">
          {rows.map(({ operator, activeCount, rating }) => {
            const pub = publicOperator(operator);
            return (
              <Card key={operator.id} data-testid={`operator-card-${operator.id}`}>
                <CardBody>
                  <Stack gap="sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/operators/${operator.id}`}
                        className="text-lg font-semibold hover:underline"
                      >
                        {pub.name}
                      </Link>
                      {pub.verified ? (
                        <Badge variant="success">{ct("verified")}</Badge>
                      ) : (
                        <Badge variant="warning">{ct("unverified")}</Badge>
                      )}
                      {rating ? (
                        <Badge variant="outline" data-testid="operator-rating">
                          {t("buyerRating", {
                            avg: rating.avg.toFixed(1),
                            count: rating.count,
                          })}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-sm text-muted">
                      {vt("basedAt", { place: pub.baseAirport || "—" })}
                    </p>
                    {pub.fleetSummary ? (
                      <p className="text-sm">{pub.fleetSummary}</p>
                    ) : null}
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-muted">
                        {t("listingsTitle", { count: activeCount })}
                      </p>
                      <Link
                        href={`/operators/${operator.id}`}
                        className="text-sm font-medium text-accent hover:underline"
                      >
                        {t("viewProfile")}
                      </Link>
                    </div>
                  </Stack>
                </CardBody>
              </Card>
            );
          })}
        </Grid>
      )}
    </main>
  );
}
