import { useTranslations } from "next-intl";
import { Check } from "lucide-react";
import { plans, type PlanId } from "@jetmarket/config";
import { formatPrice } from "@jetmarket/i18n/format";
import { Button } from "../primitives/button";
import { Badge } from "../primitives/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../primitives/card";
import { Container, Section } from "../layout/primitives";
import { cn } from "../lib/utils";

/**
 * Pricing table driven by packages/config/plans.ts.
 * Renders a POST form per paid plan -> /api/billing/checkout (303 -> provider).
 * `currentPlan` marks the owned tier; `checkoutPath`/`portalPath` overridable.
 */
export function PricingTable({
  currentPlan,
  checkoutPath = "/api/billing/checkout",
  className,
}: {
  currentPlan?: PlanId;
  checkoutPath?: string;
  className?: string;
}) {
  const t = useTranslations("pricing");
  return (
    <Section className={className} id="pricing">
      <Container>
        <div className="mb-10 text-center">
          <h2 className="text-3xl font-bold tracking-tight">{t("title")}</h2>
          <p className="mt-2 text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="mx-auto grid max-w-4xl gap-6 sm:grid-cols-2">
          {(Object.keys(plans) as PlanId[]).map((id) => {
            const plan = plans[id];
            const isCurrent = currentPlan === id;
            return (
              <Card key={id} className={cn(id === "pro" && "border-primary shadow-md")}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>{t(`plans.${id}.name`)}</CardTitle>
                    {isCurrent ? <Badge variant="secondary">{t("currentPlan")}</Badge> : null}
                  </div>
                  <CardDescription>{t(`plans.${id}.description`)}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="mb-6">
                    <span className="text-4xl font-bold">
                      {formatPrice(plan.priceCents, plan.currency)}
                    </span>
                    <span className="text-muted-foreground">{t("monthly")}</span>
                  </div>
                  <ul className="flex flex-col gap-2">
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-center gap-2 text-sm">
                        <Check className="h-4 w-4 text-primary" />
                        {t(`features.${f}`)}
                      </li>
                    ))}
                  </ul>
                </CardContent>
                <CardFooter>
                  {id === "free" ? (
                    <form action={checkoutPath} method="post" className="w-full">
                      <input type="hidden" name="plan" value="free" />
                      <Button variant="outline" className="w-full" type="submit">
                        {t("selectFree")}
                      </Button>
                    </form>
                  ) : (
                    <form action={checkoutPath} method="post" className="w-full">
                      <input type="hidden" name="plan" value={id} />
                      <Button className="w-full" type="submit" disabled={isCurrent}>
                        {t("upgrade")}
                      </Button>
                    </form>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </Container>
    </Section>
  );
}
