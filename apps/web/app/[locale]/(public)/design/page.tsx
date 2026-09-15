import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardTitle,
  Container,
  EmptyState,
  Faq,
  FeatureGrid,
  Field,
  Grid,
  Hero,
  HStack,
  Input,
  Label,
  Page,
  PricingTable,
  Section,
  Select,
  Skeleton,
  Stack,
  Textarea,
} from "@jetmarket/ui";
import { getTranslations } from "next-intl/server";

/** /design — living gallery of every primitive and block for visual review. */
export default async function DesignPage() {
  const t = await getTranslations("design");
  return (
    <Page data-testid="design-gallery">
      <Section>
        <Container>
          <Stack gap="sm">
            <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
            <p className="text-muted">{t("subtitle")}</p>
          </Stack>
        </Container>
      </Section>

      <Section>
        <Container>
          <Stack gap="lg">
            <h2 className="text-xl font-semibold">{t("primitives")}</h2>
            <Card>
              <CardHeader>
                <CardTitle>Button / Badge / Input / Field</CardTitle>
              </CardHeader>
              <CardBody>
                <Stack gap="md">
                  <HStack>
                    <Button>Primary</Button>
                    <Button variant="secondary">Secondary</Button>
                    <Button variant="ghost">Ghost</Button>
                    <Button variant="danger">Danger</Button>
                    <Button size="sm">Small</Button>
                    <Button size="lg">Large</Button>
                  </HStack>
                  <HStack>
                    <Badge>Default</Badge>
                    <Badge variant="success">Success</Badge>
                    <Badge variant="warning">Warning</Badge>
                    <Badge variant="danger">Danger</Badge>
                    <Badge variant="outline">Outline</Badge>
                  </HStack>
                  <Grid cols={2}>
                    <Field label="Text input" htmlFor="d-in" hint="With hint text">
                      <Input id="d-in" placeholder="Placeholder" />
                    </Field>
                    <Field label="Select" htmlFor="d-sel">
                      <Select id="d-sel">
                        <option>Option A</option>
                        <option>Option B</option>
                      </Select>
                    </Field>
                    <Field label="With error" error="This field is required">
                      <Input placeholder="Invalid" />
                    </Field>
                    <Field label="Textarea" htmlFor="d-ta">
                      <Textarea id="d-ta" />
                    </Field>
                  </Grid>
                  <div>
                    <Label>States</Label>
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="mt-2 h-4 w-1/2" />
                  </div>
                </Stack>
              </CardBody>
              <CardFooter>
                <p className="text-xs text-muted">Card · CardHeader · CardBody · CardFooter</p>
              </CardFooter>
            </Card>
            <EmptyState
              title="Nothing here yet"
              body="EmptyState with an action slot."
              action={<Button size="sm">Call to action</Button>}
            />
          </Stack>
        </Container>
      </Section>

      <Hero
        eyebrow="Block: Hero"
        title="Hero block title"
        subtitle="Hero subtitle rendering through the shared block."
        primaryCta={{ label: "Primary", href: "/design" }}
        secondaryCta={{ label: "Secondary", href: "/design" }}
      />
      <FeatureGrid
        title="Block: FeatureGrid"
        items={[
          { title: "Feature one", body: "Feature body copy." },
          { title: "Feature two", body: "Feature body copy." },
          { title: "Feature three", body: "Feature body copy." },
        ]}
      />
      <PricingTable
        title="Block: PricingTable"
        plans={[
          { name: "Free", price: "$0", period: "/mo", features: ["Feature A", "Feature B"], cta: { label: "Start", href: "/design" } },
          { name: "Pro", price: "$199", period: "/mo", features: ["Everything"], highlighted: true, cta: { label: "Upgrade", href: "/design" } },
        ]}
      />
      <Faq
        title="Block: Faq"
        items={[{ q: "Question?", a: "Answer." }]}
      />
    </Page>
  );
}
