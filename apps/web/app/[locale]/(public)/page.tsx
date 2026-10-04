import { Faq, FeatureGrid, Grid, Hero, PricingTable, Section, Container, Stack, Button, Input, buttonVariants } from "@jetmarket/ui";
import { getVertical } from "@jetmarket/verticals";
import { getLocale, getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { ListingCard } from "@/components/listing-card";
import { Link } from "@/i18n/navigation";
import { getRepo } from "@/lib/repo";
import { browseExpiry } from "@/lib/search";
import { publicOperator } from "@/lib/repo/types";
import { site } from "@jetmarket/config";
import { seoAlternates } from "@/lib/seo";

interface FeatureItem { title: string; body: string }
interface FaqItem { q: string; a: string }

export default async function LandingPage() {
  const vertical = getVertical();
  const t = await getTranslations(`${vertical.copy.namespace}.home`);
  const vt = await getTranslations(vertical.copy.namespace);
  const ct = await getTranslations("common");
  const repo = await getRepo();

  const featured = await repo.listListings({
    status: "active",
    vertical: vertical.slug,
    limit: 6,
    ...browseExpiry(),
  });
  const featuredOps = new Map(
    (
      await repo.listOperators({
        ids: [...new Set(featured.map((l) => l.operatorId))],
      })
    ).map((o) => [o.id, publicOperator(o)] as const),
  );

  const steps = t.raw("howItWorks.steps") as FeatureItem[];
  const faqs = t.raw("faq.items") as FaqItem[];
  const plans = vertical.fees.subscriptionPlans.map((p) => ({
    name: vt(p.nameKey),
    price: p.monthlyPriceUsd === 0 ? "$0" : `$${p.monthlyPriceUsd}`,
    period: ct("currencyPerMonth"),
    features: vt.raw(p.featuresKey) as string[],
    highlighted: p.slug === "pro",
    cta: { label: t("ctaOperator"), href: "/sign-in" },
  }));

  return (
    <>
      <Hero
        eyebrow={t("eyebrow")}
        title={t("title")}
        subtitle={t("subtitle")}
        secondaryCta={{ label: t("ctaOperator"), href: "/sign-in" }}
      >
        <form action="/search" method="get" className="flex w-full max-w-xl gap-2" data-testid="hero-search">
          <Input
            name="q"
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
          />
          <Button type="submit">{t("ctaSearch")}</Button>
        </form>
      </Hero>

      <FeatureGrid title={t("howItWorks.title")} items={steps} />

      <Section>
        <Container>
          <Stack gap="lg">
            <div className="flex items-end justify-between">
              <h2 className="text-2xl font-semibold tracking-tight">
                {t("featured.title")}
              </h2>
              <Link href="/search" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                {t("featured.viewAll")}
              </Link>
            </div>
            <Grid cols={3}>
              {featured.map((l) => (
                <ListingCard
                  key={l.id}
                  listing={l}
                  operator={featuredOps.get(l.operatorId) ?? null}
                />
              ))}
            </Grid>
          </Stack>
        </Container>
      </Section>

      <PricingTable
        title={t("pricing.title")}
        subtitle={t("pricing.subtitle")}
        plans={plans}
      />

      <Faq title={t("faq.title")} items={faqs} />
    </>
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return {
    title: site.tagline,
    alternates: seoAlternates(locale, "/"),
  };
}
