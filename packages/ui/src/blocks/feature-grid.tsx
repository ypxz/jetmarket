import { useTranslations } from "next-intl";
import { Coins, Globe, Shield, Zap, type LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../primitives/card";
import { Container, Grid, Section } from "../layout/primitives";
import type { Feature } from "@jetmarket/config";

const icons: Record<string, LucideIcon> = { zap: Zap, shield: Shield, globe: Globe, coins: Coins };

/**
 * Feature grid — resolves i18n keys from `content.features` items.
 * Server-component safe (next-intl useTranslations works in RSC).
 */
export function FeatureGrid({ features }: { features: readonly Feature[] }) {
  const t = useTranslations();
  return (
    <Section>
      <Container>
        <Grid>
          {features.map((f, i) => {
            const Icon = icons[f.icon] ?? Zap;
            return (
              <Card key={i}>
                <CardHeader>
                  <Icon className="h-6 w-6 text-primary" />
                  <CardTitle className="mt-2">{t(f.titleKey)}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{t(f.bodyKey)}</p>
                </CardContent>
              </Card>
            );
          })}
        </Grid>
      </Container>
    </Section>
  );
}
