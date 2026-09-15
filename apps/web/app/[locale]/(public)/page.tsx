import { Faq, FeatureGrid, Grid, Hero, PricingTable, Section, Container, Stack, Button, Input, buttonVariants } from "@jetmarket/ui";
import { getVertical } from "@jetmarket/verticals";
import { getTranslations } from "next-intl/server";
import { ListingCard } from "@/components/listing-card";
import { getRepo } from "@/lib/repo";
import { site } from "@jetmarket/config";

interface FeatureItem { title: string; body: string }
interface FaqItem { q: string; a: string }

export default async function LandingPage() {
  const vertical = getVertical();
  const t = await getTranslations("home");
  const vt = await getTranslations(vertical.copy.namespace);
  const ct = await getTranslations("common");
  const repo = await getRepo();

  const featured = (
    await repo.listListings({ status: "active", vertical: vertical.slug })
  ).slice(0, 6);
  const featuredOps = new Map(
    await Promise.all(
      [...new Set(featured.map((l) => l.operatorId))].map(
        async (id) => [id, (await repo.getOperator(id)) ?? null] as const,
      ),
    ),
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
              <a href="/search" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                {t("featured.viewAll")}
              </a>
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

export const metadata = { title: site.tagline };
