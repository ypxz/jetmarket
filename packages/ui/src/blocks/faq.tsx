import { useTranslations } from "next-intl";
import type { FaqItem } from "@jetmarket/config";
import { Container, Section } from "../layout/primitives";

export function FAQ({ items }: { items: readonly FaqItem[] }) {
  const t = useTranslations();
  return (
    <Section id="faq">
      <Container className="max-w-3xl">
        <h2 className="mb-8 text-center text-3xl font-bold tracking-tight">FAQ</h2>
        <div className="flex flex-col gap-6">
          {items.map((item, i) => (
            <div key={i}>
              <h3 className="font-semibold">{t(item.qKey)}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t(item.aKey)}</p>
            </div>
          ))}
        </div>
      </Container>
    </Section>
  );
}
