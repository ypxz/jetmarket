import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getVertical } from "@jetmarket/verticals";
import { Link } from "@/i18n/navigation";
import { getRepo } from "@/lib/repo";
import { listingSummary, resolveSeoPage, seoListingsQuery } from "@/lib/seo";

type Params = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const def = resolveSeoPage(getVertical(), slug);
  if (!def) return {};
  const t = await getTranslations({ locale, namespace: "seo.pages" });
  return {
    title: t(`${slug}.title`),
    description: def.introKey ? t(`${slug}.intro`) : undefined,
  };
}

export default async function SeoLandingPage({
  params,
}: {
  params: Params;
}) {
  const { locale, slug } = await params;
  const vertical = getVertical();
  const def = resolveSeoPage(vertical, slug);
  if (!def) notFound();

  const t = await getTranslations({ locale, namespace: "seo.pages" });
  const ts = await getTranslations({ locale, namespace: "seo" });
  const tc = await getTranslations({ locale, namespace: "common" });
  const repo = getRepo();
  const { type, facets } = seoListingsQuery(def);
  const listings = repo.listListings({
    status: "active",
    vertical: vertical.slug,
    type,
    facets,
  });

  return (
    <main className="mx-auto max-w-5xl px-6 py-14">
      <h1 className="text-3xl font-semibold tracking-tight">
        {t(`${slug}.title`)}
      </h1>
      <p className="mt-3 max-w-2xl text-muted">
        {def.introKey ? t(`${slug}.intro`) : ts("genericIntro")}
      </p>
      <p className="mt-2 text-xs text-muted">{tc("marketplaceNotice")}</p>

      {listings.length === 0 ? (
        <div className="mt-10 rounded-md border border-border p-6" data-testid="seo-empty">
          <p className="text-sm text-muted">{ts("emptyState")}</p>
        </div>
      ) : (
        <ul className="mt-10 grid gap-4 sm:grid-cols-2">
          {listings.map((l) => {
            const op = repo.getOperator(l.operatorId);
            return (
              <li
                key={l.id}
                className="rounded-md border border-border p-4"
                data-testid={`seo-listing-${l.id}`}
              >
                <Link
                  href={`/listing/${l.id}`}
                  className="font-medium hover:underline"
                >
                  {l.title}
                </Link>
                <p className="mt-1 text-sm text-muted">{listingSummary(l)}</p>
                <p className="mt-2 text-sm font-medium">
                  {l.currency} {l.price.toLocaleString("en-US")}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {op?.name}
                  {op ? (op.verified ? ` · ${tc("verified")}` : ` · ${tc("unverified")}`) : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      <Link
        href="/search"
        className="mt-10 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        {ts("browseAll")}
      </Link>
    </main>
  );
}
