import type { ReactNode } from "react";
import { Badge } from "./badge";
import { buttonVariants } from "./button";
import { Card, CardBody } from "./card";
import { cx } from "./cx";
import { Container, Grid, Section, Stack } from "./layout";

/**
 * Page-level blocks. Content arrives via props — blocks never own copy, so the
 * same blocks serve every vertical/locale (strings come from next-intl).
 */

export interface HeroProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  primaryCta?: { label: string; href: string };
  secondaryCta?: { label: string; href: string };
  /** Rendered under the CTAs — e.g. a search form. */
  children?: ReactNode;
}

export function Hero({
  eyebrow,
  title,
  subtitle,
  primaryCta,
  secondaryCta,
  children,
}: HeroProps) {
  return (
    <Section className="bg-surface">
      <Container>
        <Stack gap="lg" className="max-w-3xl">
          {eyebrow ? (
            <p className="text-sm font-medium uppercase tracking-wide text-primary">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            {title}
          </h1>
          {subtitle ? (
            <p className="text-lg text-muted">{subtitle}</p>
          ) : null}
          {primaryCta || secondaryCta ? (
            <div className="flex flex-wrap gap-3">
              {primaryCta ? (
                <a
                  href={primaryCta.href}
                  className={buttonVariants({ size: "lg" })}
                >
                  {primaryCta.label}
                </a>
              ) : null}
              {secondaryCta ? (
                <a
                  href={secondaryCta.href}
                  className={buttonVariants({ variant: "secondary", size: "lg" })}
                >
                  {secondaryCta.label}
                </a>
              ) : null}
            </div>
          ) : null}
          {children}
        </Stack>
      </Container>
    </Section>
  );
}

export interface FeatureGridProps {
  title?: string;
  items: { title: string; body: string }[];
  cols?: 1 | 2 | 3 | 4;
}

export function FeatureGrid({ title, items, cols = 3 }: FeatureGridProps) {
  return (
    <Section>
      <Container>
        <Stack gap="lg">
          {title ? (
            <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
          ) : null}
          <Grid cols={cols}>
            {items.map((f) => (
              <Card key={f.title}>
                <CardBody>
                  <p className="font-medium">{f.title}</p>
                  <p className="mt-1 text-sm text-muted">{f.body}</p>
                </CardBody>
              </Card>
            ))}
          </Grid>
        </Stack>
      </Container>
    </Section>
  );
}

export interface PricingPlan {
  name: string;
  price: string;
  period?: string;
  features: string[];
  cta?: { label: string; href: string };
  highlighted?: boolean;
  badge?: string;
}

export function PricingTable({
  title,
  subtitle,
  plans,
}: {
  title?: string;
  subtitle?: string;
  plans: PricingPlan[];
}) {
  return (
    <Section className="bg-surface">
      <Container>
        <Stack gap="lg">
          {title ? (
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
              {subtitle ? <p className="mt-1 text-muted">{subtitle}</p> : null}
            </div>
          ) : null}
          <Grid cols={plans.length > 2 ? 3 : 2}>
            {plans.map((p) => (
              <Card
                key={p.name}
                className={cx(p.highlighted && "border-primary shadow-pop")}
              >
                <CardBody>
                  <Stack gap="md">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold">{p.name}</p>
                      {p.badge ? <Badge>{p.badge}</Badge> : null}
                    </div>
                    <p className="text-3xl font-semibold tracking-tight">
                      {p.price}
                      {p.period ? (
                        <span className="text-sm font-normal text-muted">
                          {" "}
                          {p.period}
                        </span>
                      ) : null}
                    </p>
                    <ul className="space-y-1 text-sm text-muted">
                      {p.features.map((f) => (
                        <li key={f}>— {f}</li>
                      ))}
                    </ul>
                    {p.cta ? (
                      <a
                        href={p.cta.href}
                        className={buttonVariants({
                          variant: p.highlighted ? "primary" : "secondary",
                        })}
                      >
                        {p.cta.label}
                      </a>
                    ) : null}
                  </Stack>
                </CardBody>
              </Card>
            ))}
          </Grid>
        </Stack>
      </Container>
    </Section>
  );
}

export function Faq({
  title,
  items,
}: {
  title?: string;
  items: { q: string; a: string }[];
}) {
  return (
    <Section>
      <Container className="max-w-3xl">
        <Stack gap="lg">
          {title ? (
            <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
          ) : null}
          <Stack gap="sm">
            {items.map((item) => (
              <Card key={item.q}>
                <CardBody>
                  <p className="font-medium">{item.q}</p>
                  <p className="mt-1 text-sm text-muted">{item.a}</p>
                </CardBody>
              </Card>
            ))}
          </Stack>
        </Stack>
      </Container>
    </Section>
  );
}

export interface SiteFooterProps {
  name: string;
  /** Mandatory legal line — "marketplace, not a broker/operator". */
  legalLine: string;
  links: { label: string; href: string }[];
  copyright?: string;
}

export function SiteFooter({ name, legalLine, links, copyright }: SiteFooterProps) {
  return (
    <footer className="border-t border-border bg-surface">
      <Container className="py-10">
        <Stack gap="md">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="font-semibold">{name}</p>
            <nav className="flex flex-wrap gap-4 text-sm text-muted">
              {links.map((l) => (
                <a key={l.href} href={l.href} className="hover:text-foreground">
                  {l.label}
                </a>
              ))}
            </nav>
          </div>
          <p className="text-xs text-muted">{legalLine}</p>
          {copyright ? <p className="text-xs text-muted">{copyright}</p> : null}
        </Stack>
      </Container>
    </footer>
  );
}
